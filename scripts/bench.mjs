#!/usr/bin/env node
// Jarvis vs Hermes: the same small task suite through each harness, end to end.
//   npm run bench                                   both harnesses, 1 rep each
//   npm run bench -- --only jarvis --reps 3         one side, more reps
//   npm run bench -- --hermes-cmd "hermes chat -q {prompt} --oneshot"
//   npm run bench -- --provider codex --model gpt-5 --effort low
// Jarvis must be running (tasks go through its control socket, with its real context and tools). The first
// request shows an Allow/Deny dialog in Jarvis; allow it once per app session. Bench runs show as "Benchmark" and
// never feed memory or reflection.
// Hermes runs as a one-shot CLI (`hermes -z {prompt}` by default). Measures wall time, correctness,
// memory (idle and peak RSS of each process tree) and, for Jarvis, tokens and time to first output.
// Results print as a table and are saved to bench-results/<timestamp>.json.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const REPS = Math.max(1, Number(flag('reps', 1)))
const TIMEOUT_MS = Number(flag('timeout', 300)) * 1000
const ONLY = flag('only', null)
const HERMES_CMD = flag('hermes-cmd', process.env.HERMES_BENCH_CMD ?? 'hermes -z {prompt}')
const JARVIS_OPTS = { provider: flag('provider'), model: flag('model'), effort: flag('effort') }

const HOME = process.env.JARVIS_HOME ?? join(homedir(), '.jarvis')
const direct = join(HOME, 'control.sock')
const SOCKET = Buffer.byteLength(direct) < 100 ? direct : join(tmpdir(), `jarvis-${createHash('sha1').update(HOME).digest('hex').slice(0, 10)}.sock`)

// ---------- task suite: each answer is checkable without a model ----------

const numbers = Array.from({ length: 40 }, (_, i) => (i * 37) % 101)
const TASKS = [
  { id: 'answer', prompt: () => 'What is 1234 * 5678? Reply with only the number.', check: (out) => digits(out).includes('7006652') },
  {
    id: 'read-file',
    setup: (dir) => writeFileSync(join(dir, 'numbers.txt'), numbers.join('\n') + '\n'),
    prompt: (dir) => `Sum the numbers in ${join(dir, 'numbers.txt')} (one per line). Reply with only the sum.`,
    check: (out) => digits(out).includes(String(numbers.reduce((a, b) => a + b, 0)))
  },
  {
    id: 'list-dir',
    setup: (dir) => {
      mkdirSync(join(dir, 'docs'))
      for (const f of ['zeta.md', 'alpha.md', 'notes.txt', 'mid.md']) writeFileSync(join(dir, 'docs', f), '# x\n')
    },
    prompt: (dir) => `List the .md files in ${join(dir, 'docs')}. Reply with only their names, sorted alphabetically, comma-separated.`,
    check: (out) => /alpha\.md\s*,\s*mid\.md\s*,\s*zeta\.md/.test(out) && !out.includes('notes.txt')
  },
  {
    id: 'write-file',
    prompt: (dir) => `Create the file ${join(dir, 'hello.txt')} containing exactly the text: benchmark ok\nThen reply with only: done`,
    check: (_out, dir) => read(join(dir, 'hello.txt')).trim() === 'benchmark ok'
  }
]

const digits = (s) => String(s ?? '').replace(/[,\s]/g, '')
const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }

// ---------- process memory ----------

function processTable() {
  const rows = new Map()
  for (const line of execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,rss=,command='], { encoding: 'utf8', maxBuffer: 16 << 20 }).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) rows.set(+m[1], { ppid: +m[2], rssKb: +m[3], command: m[4] })
  }
  return rows
}

/** RSS of a process and all its descendants, in MB. */
function treeRssMb(root, table = processTable()) {
  if (!root || !table.has(root)) return 0
  const children = new Map()
  for (const [pid, r] of table) children.set(r.ppid, [...(children.get(r.ppid) ?? []), pid])
  let kb = 0
  for (const stack = [root]; stack.length;) {
    const pid = stack.pop()
    kb += table.get(pid)?.rssKb ?? 0
    stack.push(...(children.get(pid) ?? []))
  }
  return kb / 1024
}

/** Peak tree RSS while `work` runs, sampled every 250ms. */
async function withPeak(rootFn, work) {
  let peak = 0
  const sample = () => { try { peak = Math.max(peak, treeRssMb(rootFn())) } catch { /* ps hiccup */ } }
  const timer = setInterval(sample, 250)
  sample()
  try {
    return { value: await work(), peakMb: peak }
  } finally {
    clearInterval(timer)
    sample()
  }
}

function jarvisPid() {
  try {
    return Number(execFileSync('/usr/sbin/lsof', ['-t', SOCKET], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]) || null
  } catch {
    return null
  }
}

// ---------- adapters ----------

function jarvisRequest(op, args) {
  return new Promise((resolve, reject) => {
    const s = createConnection(SOCKET)
    let buf = ''
    const timer = setTimeout(() => { s.destroy(); reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)) }, TIMEOUT_MS)
    s.setEncoding('utf8')
    s.on('connect', () => s.write(JSON.stringify({ id: 1, op, args }) + '\n'))
    s.on('data', (c) => {
      buf += c
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      clearTimeout(timer)
      s.end()
      const msg = JSON.parse(buf.slice(0, nl))
      msg.error ? reject(new Error(msg.error)) : resolve(msg.result)
    })
    s.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

const jarvis = {
  name: 'jarvis',
  available: () => (jarvisPid() ? null : `Jarvis is not running (no listener on ${SOCKET})`),
  idleMb: () => treeRssMb(jarvisPid()),
  async run(prompt, cwd) {
    const pid = jarvisPid()
    const t0 = performance.now()
    const { value: run, peakMb } = await withPeak(() => pid, () => jarvisRequest('__bench', { prompt, cwd, title: 'bench', ...JARVIS_OPTS }))
    const u = run.usage ?? {}
    return {
      ok: run.status === 'succeeded', output: run.result ?? run.error ?? '', wallMs: performance.now() - t0, peakMb,
      firstOutputMs: u.firstOutputMs ?? null, inputTokens: u.inputTokens ?? null, cachedInputTokens: u.cachedInputTokens ?? null,
      outputTokens: u.outputTokens ?? null, turns: u.turns ?? null, runId: run.id
    }
  }
}

const hermesArgv = (prompt) => HERMES_CMD.trim().split(/\s+/).map((t) => (t === '{prompt}' ? prompt : t))

const hermes = {
  name: 'hermes',
  available() {
    try {
      execFileSync('/bin/sh', ['-c', `command -v ${hermesArgv('')[0]}`], { stdio: 'ignore' })
      return null
    } catch {
      return `${hermesArgv('')[0]} not found on PATH (set --hermes-cmd)`
    }
  },
  /** Anything Hermes keeps resident (its gateway LaunchAgent), excluding this script. */
  idleMb() {
    const table = processTable()
    let mb = 0
    for (const [pid, r] of table) if (/hermes/i.test(r.command) && !/bench\.mjs/.test(r.command) && pid !== process.pid) mb += r.rssKb / 1024
    return mb
  },
  async run(prompt, cwd) {
    const [cmd, ...args] = hermesArgv(prompt)
    const t0 = performance.now()
    let firstOutputMs = null
    let child
    const { value, peakMb } = await withPeak(() => child?.pid, () => new Promise((resolve) => {
      child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)
      child.stdout.on('data', (c) => { firstOutputMs ??= performance.now() - t0; out += c })
      child.stderr.on('data', (c) => { err += c })
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }) })
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
    }))
    return {
      ok: value.code === 0, output: value.out.trim() || value.err.trim().slice(-500), wallMs: performance.now() - t0, peakMb,
      firstOutputMs, inputTokens: null, cachedInputTokens: null, outputTokens: null, turns: null
    }
  }
}

// ---------- main ----------

const adapters = [jarvis, hermes].filter((a) => !ONLY || a.name === ONLY)
const results = { startedAt: new Date().toISOString(), reps: REPS, hermesCmd: HERMES_CMD, jarvis: JARVIS_OPTS, harnesses: {} }

for (const a of adapters) {
  const why = a.available()
  if (why) {
    console.log(`skip ${a.name}: ${why}`)
    results.harnesses[a.name] = { skipped: why }
    continue
  }
  const entry = (results.harnesses[a.name] = { idleMb: a.idleMb(), runs: [] })
  for (let rep = 0; rep < REPS; rep++) {
    for (const t of TASKS) {
      const dir = mkdtempSync(join(tmpdir(), `bench-${a.name}-${t.id}-`))
      try {
        t.setup?.(dir)
        const prompt = t.prompt(dir)
        let r
        try {
          r = await a.run(prompt, dir)
        } catch (err) {
          r = { ok: false, output: err.message, wallMs: null, peakMb: null }
        }
        const correct = r.ok && t.check(r.output, dir)
        entry.runs.push({ task: t.id, rep, correct, ...r, output: String(r.output).slice(0, 300) })
        console.log(`${a.name.padEnd(7)} ${t.id.padEnd(11)} rep ${rep + 1}  ${correct ? 'pass' : 'FAIL'}  ${r.wallMs == null ? '—' : (r.wallMs / 1000).toFixed(1) + 's'}${correct ? '' : `  ${JSON.stringify(String(r.output).slice(0, 120))}`}`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }
}

// ---------- summary ----------

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b)
  return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null
}
const fmt = (x, unit = '', digits = 1) => (x == null ? '—' : `${x.toFixed(digits)}${unit}`)

const summary = {}
for (const [name, h] of Object.entries(results.harnesses)) {
  if (h.skipped) continue
  const runs = h.runs
  summary[name] = {
    pass: `${runs.filter((r) => r.correct).length}/${runs.length}`,
    medianWallS: median(runs.map((r) => r.wallMs && r.wallMs / 1000)),
    medianFirstOutputS: median(runs.map((r) => r.firstOutputMs && r.firstOutputMs / 1000)),
    idleMb: h.idleMb,
    peakMb: Math.max(0, ...runs.map((r) => r.peakMb ?? 0)),
    medianInputTokens: median(runs.map((r) => r.inputTokens)),
    medianCachedTokens: median(runs.map((r) => r.cachedInputTokens)),
    medianOutputTokens: median(runs.map((r) => r.outputTokens))
  }
}
results.summary = summary

console.log('\n' + ['harness', 'pass', 'wall p50', 'first out p50', 'idle RSS', 'peak RSS', 'in tok p50', 'cached p50', 'out tok p50'].map((h) => h.padEnd(15)).join(''))
for (const [name, s] of Object.entries(summary)) {
  console.log([name, s.pass, fmt(s.medianWallS, 's'), fmt(s.medianFirstOutputS, 's'), fmt(s.idleMb, ' MB', 0), fmt(s.peakMb, ' MB', 0),
    fmt(s.medianInputTokens, '', 0), fmt(s.medianCachedTokens, '', 0), fmt(s.medianOutputTokens, '', 0)].map((c) => String(c).padEnd(15)).join(''))
}
console.log('\nIdle/peak RSS are whole process trees: Jarvis includes the app itself; Hermes counts the one-shot CLI plus any resident Hermes process.')

const outDir = join(process.cwd(), 'bench-results')
mkdirSync(outDir, { recursive: true })
const file = join(outDir, `${results.startedAt.replace(/[:.]/g, '-')}.json`)
writeFileSync(file, JSON.stringify(results, null, 2))
console.log(`Saved ${file}`)
