import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadModule } from './load-module.mjs'

/** Self-repair commits land here; origin is never written. */
const LOCAL = 'jarvis/local'
/** A held ref lock makes every update of the local branch fail, like a push the remote refused. */
const lockLocal = (r) => { mkdirSync(join(r.src, '.git', 'refs', 'heads', 'jarvis'), { recursive: true }); writeFileSync(join(r.src, '.git', 'refs', 'heads', 'jarvis', 'local.lock'), '') }
const unlockLocal = (r) => rmSync(join(r.src, '.git', 'refs', 'heads', 'jarvis', 'local.lock'), { force: true })
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()

/** A bare "origin" and a checkout of it holding a tiny harness: add() is buggy, and its test suite passes. */
function repos() {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-repair-'))
  const origin = join(root, 'origin.git'), src = join(root, 'src')
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin])
  mkdirSync(join(src, 'tests'), { recursive: true }); mkdirSync(join(src, 'node_modules'))
  git(root, 'init', '--quiet', '--initial-branch=main', src)
  writeFileSync(join(src, '.gitignore'), 'node_modules\n')
  writeFileSync(join(src, 'package.json'), JSON.stringify({ type: 'module', scripts: { typecheck: 'node -e 0', test: 'node --test' } }))
  writeFileSync(join(src, 'package-lock.json'), '{}')
  writeFileSync(join(src, 'math.mjs'), 'export const add = (a, b) => a - b\n')
  writeFileSync(join(src, 'tests/smoke.test.mjs'), "import test from 'node:test'\ntest('loads', async () => { await import('../math.mjs') })\n")
  git(src, 'add', '-A'); git(src, 'commit', '--quiet', '-m', 'init'); git(src, 'remote', 'add', 'origin', origin); git(src, 'push', '--quiet', 'origin', 'main')
  return { root, origin, src, done: () => rmSync(root, { recursive: true, force: true }) }
}

const fix = {
  'math.mjs': 'export const add = (a, b) => a + b\n',
  'tests/math.test.mjs': "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../math.mjs'\ntest('add sums', () => assert.equal(add(2, 3), 5))\n"
}

const assessment = { size: 'small', reason: 'Localized addition defect', files: ['math.mjs'], components: ['math'], estimatedMinutes: 10, validation: 'regression', priority: 60 }
const structured = (text, patch = {}) => JSON.stringify({ outcome: text.startsWith('NOT_A_BUG:') ? 'not_a_bug' : 'complete', summary: text.split('\n').at(-1), diagnosis: text, progress: 'Implemented change', nextAction: '', assessment, validation: { command: [], evidence: text, before: null, after: null, lowerIsBetter: true }, ...patch })
const proposal = (patch = {}) => JSON.stringify({ none: false, title: 'wrong addition', evidence: 'math.mjs subtracts', expected: 'add(2,3) equals 5', assessment, ...patch })

async function harness(r, agent, settings = {}) {
  process.env.JARVIS_SELF_REPAIR = '1'
  const bus = new EventEmitter(), kv = new Map(), audits = [], lessons = [], sent = [], starts = []
  const faults = new Map()
  const config = { update: { branch: 'main' }, defaultProvider: 'claude', selfRepair: { enabled: true, maxPerDay: 3, proactive: false, ...settings }, notifications: { imessageTarget: '+15555550125' } }
  const api = await loadModule('src/main/self-repair.ts', {
    electron: { app: { isPackaged: false } },
    './db': { audit: (...a) => audits.push(a), kvGet: (k) => structuredClone(kv.get(k) ?? null), kvSet: (k, v) => kv.set(k, structuredClone(v)) },
    './bus': { bus },
    './rsi-metrics': { recordRsiMetric() {}, rsiStatistics: () => [] },
    './config': { cfg: () => config },
    './env': { readEnvFile: () => ({ SLACK_BOT_TOKEN: 'xoxb-super-secret-token' }) },
    './gateways': { deliver: async (...a) => { sent.push(a) } },
    './faults': {
      recordFault: (input) => fault({ fingerprint: 'discovered', source: input.source, name: input.error.name, message: input.error.message, sample: input.context, assessment: input.assessment }),
      getFault: fp => faults.get(fp),
      reopenInterruptedFaults: () => { for (const f of faults.values()) if (f.status === 'repairing') f.status = 'open' },
      nextDueFault: max => [...faults.values()].find(f => f.status === 'open' && f.nextAttemptAt <= Date.now() && (!max || f.attempts < max)),
      listFaults: ({ status }) => [...faults.values()].filter((f) => !status || f.status === status),
      updateFault: (fp, patch) => { const f = { ...faults.get(fp), ...patch }; faults.set(fp, f); return f }
    },
    './improvement': { noteLesson: (_a, title, text) => lessons.push(`${title}: ${text}`), readImprovement: () => lessons.join('\n') },
    './paths': { paths: { home: r.root } },
    './profile-context': { OWNER_ID: 'owner', withProfile: (_id, fn) => fn() },
    './runs': {
      providerAvailableAt: provider => config.unavailable?.[provider] ?? 0,
      startRun: (input) => { starts.push(input); return { id: `run-${starts.length}` } },
      waitForRun: async (id) => {
        const input = starts.at(-1)
        if (input.title.includes('Scope')) return { id, status: 'succeeded', result: JSON.stringify(assessment), ...config.scopeReply }
        const result = await agent(input, id)
        if (result.status === 'succeeded' && !input.title.includes('Discover') && typeof result.result === 'string' && !result.result.startsWith('{')) result.result = structured(result.result)
        return result
      }
    },
    './updater': { buildEnv: () => process.env, checkForUpdates: async () => ({}), sourceDir: () => r.src }
  })
  const fault = (patch = {}) => { const f = { fingerprint: 'fp1', source: 'crash', cls: 'code', name: 'TypeError', message: 'add() returns wrong sum', sample: 'at add', count: 1, status: 'open', attempts: 0, nextAttemptAt: 0, commit: null, note: null, firstSeen: 0, assessment, ...patch }; faults.set(f.fingerprint, f); return f }
  const settle = async () => { for (let i = 0; i < 600 && (api.repairing() || starts.length === 0 && [...faults.values()].some(f => f.status === 'open' && f.nextAttemptAt <= Date.now())); i++) await new Promise((res) => setTimeout(res, 50)) }
  return { api, bus, kv, audits, lessons, sent, starts, faults, fault, settle, config }
}

const later = async (h, ms) => { const now = Date.now; try { Date.now = () => now() + ms; h.api.sweepFaults(); await h.settle() } finally { Date.now = now } }
const write = (cwd, files) => { for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), text) } }

test('a due fault is repaired in a worktree, verified and committed to the local branch without pushing', async () => {
  const r = repos()
  try {
    const upstream = git(r.src, 'ls-remote', r.origin, 'refs/heads/main')
    const h = await harness(r, (input, id) => { write(input.cwd, fix); return { id, status: 'succeeded', result: 'Done.\nFix add() to sum its arguments' } })
    h.fault()
    h.api.sweepFaults()
    await h.settle()
    const f = h.faults.get('fp1')
    assert.equal(f.status, 'shipped', f.note)
    assert.equal(h.starts[0].kind, 'repair')
    assert.equal(h.starts[0].provider, 'claude')
    assert.equal(git(r.src, 'rev-parse', LOCAL), f.commit)
    assert.equal(git(r.src, 'ls-remote', r.origin, 'refs/heads/main'), upstream, 'origin is never written')
    assert.equal(git(r.src, 'ls-remote', r.origin, 'refs/heads/jarvis/*'), '', 'no branches are published')
    assert.match(git(r.src, 'log', '-1', '--format=%s', f.commit, '--'), /^Self-repair: Fix add\(\) to sum its arguments$/)
    assert.equal(git(r.src, 'branch', '--list', 'jarvis/repair-*'), '', 'merged repair branches are cleaned')
    assert.equal(git(r.src, 'worktree', 'list').split('\n').length, 1, 'worktrees are removed')
    assert.equal(git(r.src, 'branch', '--show-current'), 'main', "the owner's checkout is untouched")
    assert.match(h.lessons.join('\n'), /Shipped: Fix add/)
    assert.match(h.sent[0][2], /fixed itself/)
  } finally { r.done() }
})

test('changes that do not prove the fix are never shipped', async () => {
  const cases = {
    'nested regression never passes': { ...fix, 'tests/nested/failure.test.mjs': "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('fails forever', () => assert.fail('broken'))\n" },
    'no regression test': { 'math.mjs': fix['math.mjs'] },
    'test passes without the fix': { 'math.mjs': fix['math.mjs'], 'tests/math.test.mjs': "import test from 'node:test'\ntest('trivial', () => {})\n" },
    'secret in diff': { ...fix, 'math.mjs': 'export const add = (a, b) => a + b // xoxb-super-secret-token\n' },
    'skipped test': { ...fix, 'tests/smoke.test.mjs': "import test from 'node:test'\ntest.skip('loads', () => {})\ntest('x', () => {})\n" }
  }
  for (const [name, files] of Object.entries(cases)) {
    const r = repos()
    try {
      const before = git(r.src, 'rev-parse', 'main')
      const h = await harness(r, (input, id) => { write(input.cwd, files); return { id, status: 'succeeded', result: 'Fix it' } })
      h.fault()
      h.api.sweepFaults()
      await h.settle()
      const f = h.faults.get('fp1')
      assert.equal(f.status, 'open', `${name}: ${f.note}`)
      assert.equal(f.attempts, 1, name)
      assert.ok(f.nextAttemptAt > Date.now(), name)
      assert.equal(git(r.src, 'rev-parse', LOCAL), before, `${name} must not ship`)
      assert.match(h.lessons.join('\n'), /Not shipped/, name)
    } finally { r.done() }
  }
})

test('NOT_A_BUG is ignored, outages do not use up attempts, and the third failure is final', async () => {
  const r = repos()
  try {
    let reply = { status: 'succeeded', result: 'NOT_A_BUG: provider outage' }
    const h = await harness(r, (_input, id) => ({ id, ...reply }), { maxAttempts: 3 })
    h.fault()
    h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('fp1').status, 'ignored')

    reply = { status: 'failed', error: 'Claude AI usage limit reached|1759500000' }
    h.fault({ fingerprint: 'fp2' })
    h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('fp2').status, 'open')
    assert.equal(h.faults.get('fp2').attempts, 0)

    reply = { status: 'failed', error: 'Implementation failed' }
    h.fault({ fingerprint: 'fp3', attempts: 2 })
    h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('fp3').status, 'failed')
    assert.match(h.sent.at(-1)[2], /couldn't fix itself after 3 tries/)
  } finally { r.done() }
})

test('a shipped fix the updater rolled back is reverted locally and its fault reopened; foreign commits are left alone', async () => {
  const r = repos()
  try {
    const h = await harness(r, (input, id) => { write(input.cwd, fix); return { id, status: 'succeeded', result: 'Fix add' } })
    h.fault()
    h.api.sweepFaults(); await h.settle()
    const shipped = h.faults.get('fp1').commit
    h.kv.set('update:failedCommit', shipped)
    h.api.sweepFaults(); await h.settle()
    const f = h.faults.get('fp1')
    assert.equal(f.status, 'open')
    assert.equal(f.commit, null)
    assert.match(f.note, /rolled back by the updater and reverted/)
    const tip = git(r.src, 'rev-parse', LOCAL)
    assert.match(git(r.src, 'log', '-1', '--format=%s', tip, '--'), /^Revert "Self-repair: Fix add"/)
    assert.equal(git(r.src, 'show', `${tip}:math.mjs`), 'export const add = (a, b) => a - b')

    // A rolled-back commit Jarvis didn't ship is marked handled once, without looping or reverting.
    h.kv.set('update:failedCommit', 'f'.repeat(40))
    h.api.sweepFaults(); await h.settle()
    assert.equal(h.kv.get('self-repair:reverted'), 'f'.repeat(40))
    assert.equal(git(r.src, 'rev-parse', LOCAL), tip)
  } finally { r.done() }
})

test('verification helpers parse renames and identify skipped tests and leaked secrets', async () => {
  const r = repos()
  try {
    const { api } = await harness(r, () => ({}))
    const changes = api.parseChanges('M\tsrc/main/ops.ts\nR100\tsrc/main/updater.ts\tsrc/main/other.ts\nR090\ttests/a.test.mjs\tsrc/a.mjs')
    assert.deepEqual(changes[1], { status: 'R100', path: 'src/main/other.ts', from: 'src/main/updater.ts' })
    assert.ok(api.weakenedTests(["+test.skip('x', () => {})"]))
    assert.ok(api.weakenedTests(["+test('x', { skip: true }, () => {})"]))
    assert.equal(api.weakenedTests(["+test('skips nothing', () => {})"]), null)
    assert.equal(api.leakedSecret('+x = "abcdefghijklmnop"', ['abcdefghijklmnop']), true)
    assert.equal(api.leakedSecret('+short', ['short']), false)
  } finally { r.done() }
})

test('proactive discovery queues a candidate which independently proves and ships a repair branch', async () => {
  const r = repos()
  try {
    const h = await harness(r, (input, id) => {
      if (input.title.includes('Discover')) return { id, status: 'succeeded', result: proposal({ title: 'add returns wrong sum' }) }
      write(input.cwd, fix)
      return { id, status: 'succeeded', result: 'Fix addition' }
    }, { proactive: true, intervalHours: 6 })
    h.api.sweepFaults(); await h.settle()
    assert.equal(h.starts.length, 2)
    assert.ok(h.starts.every(s => s.kind === 'repair' && s.cwd !== r.src))
    assert.equal(h.faults.get('discovered').status, 'shipped')
    assert.equal(h.kv.get('self-repair:started').length, 1, 'discovery does not consume an implementation slice')
    assert.match(h.sent[0][2], /queued an improvement/)
    h.api.sweepFaults(); await h.settle()
    assert.equal(h.starts.length, 2, 'discovery cooldown persists')
  } finally { r.done() }
})

test('discovery edits cannot ship or consume the implementation budget, and disabling prevents shipping', async () => {
  const r = repos()
  try {
    const before = git(r.src, 'ls-remote', r.origin, 'refs/heads/main')
    const h = await harness(r, (input, id) => {
      write(input.cwd, fix)
      return { id, status: 'succeeded', result: input.title.includes('Discover') ? proposal({ none: true }) : structured('NOT_A_BUG: no useful change') }
    }, { proactive: true, maxPerDay: 1 })
    h.api.sweepFaults(); await h.settle()
    h.fault(); h.api.sweepFaults(); await h.settle()
    assert.equal(h.starts.length, 2)
    assert.equal(h.kv.get('self-repair:started').length, 1)
    assert.equal(git(r.src, 'ls-remote', r.origin, 'refs/heads/main'), before)
    const disabled = await harness(r, (input, id) => {
      write(input.cwd, fix)
      disabled.config.selfRepair.enabled = false
      return { id, status: 'succeeded', result: 'Fix addition' }
    })
    disabled.fault(); disabled.api.sweepFaults(); await disabled.settle()
    assert.equal(git(r.src, 'ls-remote', r.origin, 'refs/heads/main'), before)
    assert.equal(disabled.faults.get('fp1').attempts, 0)
    assert.match(disabled.faults.get('fp1').note, /disabled before shipping/)
  } finally { r.done() }
})

for (const state of ['dirty', 'feature branch', 'unpublished commit']) test(`self-repair never touches the owner's checkout when it has ${state}`, async () => {
  const r = repos()
  try {
    if (state === 'dirty') writeFileSync(join(r.src, 'my-work.txt'), 'keep this')
    if (state === 'feature branch') git(r.src, 'switch', '-c', 'my-feature')
    if (state === 'unpublished commit') { writeFileSync(join(r.src, 'my-work.txt'), 'keep this'); git(r.src, 'add', '-A'); git(r.src, 'commit', '-m', 'my work') }
    const before = git(r.src, 'status', '--porcelain'), head = git(r.src, 'rev-parse', 'HEAD'), branch = git(r.src, 'branch', '--show-current')
    const h = await harness(r, (input, id) => {
      assert.notEqual(input.cwd, r.src)
      write(input.cwd, fix)
      return { id, status: 'succeeded', result: 'Fix in worktree' }
    })
    h.fault(); h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('fp1').status, 'shipped', h.faults.get('fp1').note)
    assert.equal(git(r.src, 'status', '--porcelain'), before)
    assert.equal(git(r.src, 'rev-parse', 'HEAD'), head)
    assert.equal(git(r.src, 'branch', '--show-current'), branch)
    assert.equal(git(r.src, 'rev-parse', LOCAL), h.faults.get('fp1').commit)
  } finally { r.done() }
})

test('cleanup failures retain a durable retry without changing a shipped fault back to failed', async () => {
  const r = repos()
  try {
    const h = await harness(r, (input, id) => { write(input.cwd, fix); return { id, status: 'succeeded', result: 'Fix addition' } })
    h.fault(); h.api.sweepFaults(); await h.settle()
    const commit = h.faults.get('fp1').commit
    assert.equal(h.faults.get('fp1').status, 'shipped', h.faults.get('fp1').note)
    // A shipped repair branch whose deletion fails (its ref is locked) stays queued for a retry.
    git(r.src, 'branch', 'jarvis/repair-held', commit)
    const lock = join(r.src, '.git', 'refs', 'heads', 'jarvis', 'repair-held.lock')
    writeFileSync(lock, '')
    h.kv.set('self-repair:cleanup', [{ proposal: 'jarvis/repair-held', commit }])
    await later(h, 61_000)
    assert.equal(h.kv.get('self-repair:cleanup').length, 1)
    rmSync(lock)
    await later(h, 200_000)
    assert.deepEqual(h.kv.get('self-repair:cleanup'), [])
    assert.equal(git(r.src, 'branch', '--list', 'jarvis/repair-*'), '')
    assert.equal(h.faults.get('fp1').status, 'shipped')
  } finally { r.done() }
})

test('a repair branch another writer advances is preserved during cleanup', async () => {
  const r = repos()
  try {
    const base = git(r.src, 'rev-parse', 'HEAD')
    const h = await harness(r, (input, id) => { write(input.cwd, fix); return { id, status: 'succeeded', result: 'Fix addition' } })
    h.fault(); h.api.sweepFaults(); await h.settle()
    // Someone else's branch with a recorded cleanup whose tip no longer matches.
    git(r.src, 'branch', 'jarvis/repair-other', base)
    h.kv.set('self-repair:cleanup', [{ proposal: 'jarvis/repair-other', commit: h.faults.get('fp1').commit }])
    await later(h, 61_000)
    assert.equal(git(r.src, 'rev-parse', 'jarvis/repair-other'), base)
    assert.deepEqual(h.kv.get('self-repair:cleanup'), [])
  } finally { r.done() }
})

test('root-cause evidence is retained in commits and lessons with commit credentials redacted', async () => {
  const r = repos()
  try {
    const h = await harness(r, (input, id) => {
      write(input.cwd, fix)
      return { id, status: 'succeeded', result: 'ROOT_CAUSE: math.mjs add subtracts; xoxb-super-secret-token\nREGRESSION: math.test.mjs fails before and passes after\nVALIDATION: typecheck and tests pass\nFix addition' }
    })
    h.fault(); h.api.sweepFaults(); await h.settle()
    const log = git(r.src, 'log', '-1', '--format=%B', h.faults.get('fp1').commit)
    assert.match(log, /ROOT_CAUSE: math.mjs add subtracts/)
    assert.match(log, /REGRESSION:/)
    assert.ok(!log.includes('xoxb-super-secret-token'))
    assert.match(h.lessons.join('\n'), /ROOT_CAUSE:/)
  } finally { r.done() }
})


test('RSI can improve formerly protected harness files and package metadata', async () => {
  const r = repos()
  try {
    const h = await harness(r, (input, id) => {
      write(input.cwd, { ...fix,
        'src/main/self-repair.ts': 'export const improved = true\n',
        'package.json': JSON.stringify({ type: 'module', scripts: { typecheck: 'node -e 0', test: 'node --test' } })
      })
      assert.doesNotMatch(input.prompt, /protected|1500/)
      return { id, status: 'succeeded', result: 'Improve harness and package metadata' }
    })
    h.fault(); h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('fp1').status, 'shipped', h.faults.get('fp1').note)
  } finally { r.done() }
})

test('a transient revert failure retries without marking the rollback handled', async () => {
  const r = repos()
  try {
    const h = await harness(r, (input, id) => { write(input.cwd, fix); return { id, status: 'succeeded', result: 'Fix addition' } })
    h.fault(); h.api.sweepFaults(); await h.settle()
    const shipped = h.faults.get('fp1').commit
    lockLocal(r)
    h.kv.set('update:failedCommit', shipped)
    h.api.sweepFaults(); await h.settle()
    assert.notEqual(h.kv.get('self-repair:reverted'), shipped)
    assert.equal(h.faults.get('fp1').status, 'shipped')
    unlockLocal(r)
    await later(h, 61_000)
    assert.equal(h.kv.get('self-repair:reverted'), shipped)
    assert.equal(h.faults.get('fp1').status, 'open')
  } finally { r.done() }
})

test('discovery uses the small RSI model independently of the default provider', async () => {
  const r = repos()
  try {
    const h = await harness(r, (input, id) => {
      assert.equal(input.provider, 'claude')
      assert.equal(input.model, 'sonnet')
      if (input.title.includes('Discover')) return { id, status: 'succeeded', result: proposal() }
      write(input.cwd, fix)
      return { id, status: 'succeeded', result: 'Fix addition' }
    }, { proactive: true })
    h.config.defaultProvider = 'codex'
    h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('discovered').status, 'shipped')
  } finally { r.done() }
})


test('the triggering scope review selects the large model before implementation', async () => {
  const r = repos()
  try {
    const h = await harness(r, (input, id) => {
      assert.equal(input.provider, 'codex'); assert.equal(input.model, 'sol')
      write(input.cwd, fix)
      return { id, status: 'succeeded', result: structured('Fix broad task', { assessment: { ...assessment, size: 'large' } }) }
    })
    h.fault({ assessment: { ...assessment, size: 'large', reason: 'Cross-component change', components: ['math', 'runtime'] } })
    h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('fp1').status, 'shipped')
  } finally { r.done() }
})

test('raw one-off faults get a cheap scope review before implementation', async () => {
  const r = repos()
  try {
    const h = await harness(r, (input, id) => { write(input.cwd, fix); return { id, status: 'succeeded', result: structured('Fix reviewed fault') } })
    h.fault({ assessment: null }); h.api.sweepFaults(); await h.settle()
    assert.equal(h.starts.length, 2)
    assert.match(h.starts[0].title, /Scope/)
    assert.equal(h.starts[0].model, 'sonnet')
    assert.equal(h.faults.get('fp1').assessment.reason, assessment.reason)
    assert.equal(h.faults.get('fp1').status, 'shipped')
  } finally { r.done() }
})

test('continuation preserves workspace, progress and session while escalation selects GPT', async () => {
  const r = repos()
  try {
    let cwd
    const h = await harness(r, (input, id) => {
      if (!cwd) {
        cwd = input.cwd; write(cwd, { 'math.mjs': fix['math.mjs'] })
        return { id, status: 'succeeded', sessionId: 'review-session', result: structured('Needs broader work', { outcome: 'escalate', progress: 'Addition fixed; regression remains', nextAction: 'Add regression' }) }
      }
      assert.equal(input.cwd, cwd)
      assert.equal(readFileSync(join(cwd, 'math.mjs'), 'utf8'), fix['math.mjs'])
      assert.match(input.prompt, /Addition fixed; regression remains/)
      assert.equal(input.model, 'sol'); assert.equal(input.resumeSession, undefined)
      write(cwd, fix); return { id, status: 'succeeded', result: structured('Fix continued addition') }
    }, { maxPerDay: 0 })
    h.fault(); h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('fp1').attempts, 0)
    assert.equal(h.kv.get('rsi:job:fp1').phase, 'working')
    h.faults.get('fp1').nextAttemptAt = 0
    h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('fp1').status, 'shipped', h.faults.get('fp1').note)
    assert.equal(h.kv.get('rsi:job:fp1'), null)
    assert.equal(git(r.src, 'worktree', 'list').split('\n').length, 1)
  } finally { r.done() }
})

test('same-model continuation resumes its session and timeouts preserve work without consuming attempts', async () => {
  const r = repos()
  try {
    let slice = 0, cwd
    const h = await harness(r, (input, id) => {
      slice++
      if (slice === 1) {
        cwd = input.cwd; write(cwd, { 'math.mjs': fix['math.mjs'] })
        return { id, status: 'failed', error: 'Timed out after 30 minutes', sessionId: 'slice-session' }
      }
      assert.equal(input.cwd, cwd); assert.equal(input.resumeSession, 'slice-session')
      assert.equal(input.model, 'sonnet')
      write(cwd, fix); return { id, status: 'succeeded', result: structured('Fix resumed addition') }
    })
    h.fault(); h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('fp1').attempts, 0)
    h.faults.get('fp1').nextAttemptAt = 0
    h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('fp1').status, 'shipped')
  } finally { r.done() }
})

test('an exhausted selected provider routes work to the other RSI model instead of waiting', async () => {
  const r = repos()
  try {
    const h = await harness(r, (input, id) => {
      assert.equal(input.model, 'sonnet')
      write(input.cwd, fix); return { id, status: 'succeeded', result: structured('Fix available task', { assessment: { ...assessment, size: 'large' } }) }
    })
    h.config.unavailable = { codex: Date.now() + 3600000 }
    h.fault({ fingerprint: 'large', assessment: { ...assessment, size: 'large' } })
    h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('large').status, 'shipped', h.faults.get('large').note)
  } finally { r.done() }
})

test('a job waits only when both RSI providers are exhausted', async () => {
  const r = repos()
  try {
    const h = await harness(r, () => assert.fail('no model should start'))
    h.config.unavailable = { codex: Date.now() + 3600000, claude: Date.now() + 1800000 }
    h.fault({ assessment: { ...assessment, size: 'large' } })
    h.api.sweepFaults(); await new Promise(r => setImmediate(r))
    assert.equal(h.faults.get('fp1').attempts, 0)
    assert.ok(h.faults.get('fp1').nextAttemptAt > Date.now())
    assert.equal(h.starts.length, 0)
  } finally { r.done() }
})

test('cleanup can ship with checks and no artificial regression test', async () => {
  const r = repos()
  try {
    const h = await harness(r, (input, id) => {
      write(input.cwd, { 'math.mjs': 'export const add = (a, b) => a - b // documented behavior\n' })
      return { id, status: 'succeeded', result: structured('Clarify behavior', { assessment: { ...assessment, validation: 'checks' } }) }
    })
    h.fault({ name: 'Improvement', assessment: { ...assessment, validation: 'checks' } }); h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('fp1').status, 'shipped', h.faults.get('fp1').note)
  } finally { r.done() }
})

test('a missing module on the baseline is not an observed failing assertion', async () => {
  const r = repos()
  try {
    const h = await harness(r, (input, id) => {
      write(input.cwd, { 'new.mjs': 'export const value = 1\n', 'tests/new.test.mjs': "import test from 'node:test'\nimport { value } from '../new.mjs'\ntest('new', () => { if (value !== 1) throw Error('bad') })\n" })
      return { id, status: 'succeeded', result: structured('Add module') }
    })
    h.fault(); h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('fp1').status, 'open')
    assert.match(h.faults.get('fp1').note, /baseline failed to load/)
  } finally { r.done() }
})

test('an interrupted verified commit resumes shipping without repeating implementation', async () => {
  const r = repos()
  try {
    const h = await harness(r, (input, id) => {
      write(input.cwd, fix)
      lockLocal(r)
      return { id, status: 'succeeded', result: structured('Fix durable ship') }
    })
    h.fault(); h.api.sweepFaults(); await h.settle()
    const job = h.kv.get('rsi:job:fp1')
    assert.equal(job.phase, 'committed'); assert.equal(job.commit, git(job.dir, 'rev-parse', 'HEAD'))
    unlockLocal(r); h.faults.get('fp1').nextAttemptAt = 0
    h.api.sweepFaults(); await h.settle()
    assert.equal(h.starts.length, 1, 'shipping resumes without another model process')
    assert.equal(h.faults.get('fp1').status, 'shipped', h.faults.get('fp1').note)
    assert.equal(git(r.src, 'rev-parse', LOCAL), h.faults.get('fp1').commit)
    assert.equal(h.kv.get('rsi:job:fp1'), null)
  } finally { r.done() }
})


test('an attempt that only ever continues is bounded and releases its empty workspace', async () => {
  const r = repos()
  try {
    const h = await harness(r, (_input, id) => ({ id, status: 'succeeded', result: structured('Still investigating', { outcome: 'continue', progress: 'Looked around', nextAction: 'Look more' }) }), { maxPerDay: 0, maxAttempts: 1 })
    h.fault()
    for (let i = 0; i < 20 && h.faults.get('fp1').status === 'open'; i++) { h.faults.get('fp1').nextAttemptAt = 0; h.api.sweepFaults(); await h.settle() }
    assert.equal(h.starts.length, 12)
    assert.equal(h.faults.get('fp1').status, 'failed')
    assert.match(h.faults.get('fp1').note, /12 slices/)
    assert.equal(h.kv.get('rsi:job:fp1'), null)
    assert.equal(git(r.src, 'worktree', 'list').split('\n').length, 1)
    assert.equal(git(r.src, 'branch', '--list', 'jarvis/repair-*'), '', 'an empty repair branch is deleted')
  } finally { r.done() }
})

test('a scope review that fails for a non-provider reason spends an attempt instead of retrying forever', async () => {
  const r = repos()
  try {
    const h = await harness(r, () => assert.fail('implementation must not start'))
    h.config.scopeReply = { status: 'failed', error: 'Timed out after 30 minutes' }
    h.fault({ assessment: null }); h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('fp1').status, 'open')
    assert.equal(h.faults.get('fp1').attempts, 1)
    assert.match(h.faults.get('fp1').note, /Scope review failed/)
    h.config.scopeReply = { status: 'failed', error: 'Claude AI usage limit reached|1759500000' }
    h.fault({ fingerprint: 'fp2', assessment: null }); h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('fp2').attempts, 0, 'outages still wait without spending an attempt')
  } finally { r.done() }
})

test('a settled job keeps stray edits as a local commit on its repair branch', async () => {
  const r = repos()
  try {
    let proposal
    const h = await harness(r, (input, id) => {
      proposal = git(input.cwd, 'branch', '--show-current')
      write(input.cwd, { 'notes.txt': 'scratch investigation' })
      return { id, status: 'succeeded', result: 'NOT_A_BUG: environment problem' }
    })
    h.fault(); h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('fp1').status, 'ignored')
    assert.equal(git(r.src, 'branch', '--show-current'), 'main')
    assert.equal(git(r.src, 'status', '--porcelain'), '')
    assert.equal(git(r.src, 'show', `${proposal}:notes.txt`), 'scratch investigation')
    assert.equal(h.kv.get('rsi:job:fp1'), null)
  } finally { r.done() }
})

test('a workspace whose base the agent moved is replaced instead of failing every later attempt', async () => {
  const r = repos()
  try {
    const dirs = []
    const h = await harness(r, (input, id) => {
      dirs.push(input.cwd)
      write(input.cwd, fix)
      if (dirs.length === 1) { git(input.cwd, 'add', '-A'); git(input.cwd, 'commit', '--quiet', '-m', 'agent commit') }
      return { id, status: 'succeeded', result: 'Fix addition' }
    }, { maxPerDay: 0 })
    h.fault(); h.api.sweepFaults(); await h.settle()
    assert.match(h.faults.get('fp1').note, /changed the base commit/)
    h.faults.get('fp1').nextAttemptAt = 0
    h.api.sweepFaults(); await h.settle()
    assert.notEqual(dirs[1], dirs[0])
    assert.equal(h.faults.get('fp1').status, 'shipped', h.faults.get('fp1').note)
  } finally { r.done() }
})

test('a verified commit that no longer applies after the local branch moves starts over on the new base', async () => {
  const r = repos()
  try {
    let slice = 0
    const h = await harness(r, (input, id) => {
      slice++
      write(input.cwd, fix)
      if (slice === 1) {
        const other = join(r.root, 'other')
        git(r.src, 'worktree', 'add', '--quiet', other, LOCAL)
        writeFileSync(join(other, 'math.mjs'), 'export const add = (a, b) => b - a\n')
        git(other, 'add', '-A'); git(other, 'commit', '--quiet', '-m', 'conflicting change')
        git(r.src, 'worktree', 'remove', '--force', other)
      }
      return { id, status: 'succeeded', result: 'Fix addition' }
    }, { maxPerDay: 0 })
    h.fault(); h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('fp1').status, 'open')
    assert.match(h.faults.get('fp1').note, /no longer applies/)
    assert.equal(h.kv.get('rsi:job:fp1'), null, 'the stale job is discarded')
    assert.match(git(r.src, 'branch', '--list', 'jarvis/repair-*'), /jarvis\/repair-fp1/, 'the unshipped commit stays on a local branch')
    h.faults.get('fp1').nextAttemptAt = 0
    h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('fp1').status, 'shipped', h.faults.get('fp1').note)
    assert.equal(h.starts.length, 2)
  } finally { r.done() }
})

test('a regression test may bring its own fixture to the baseline', async () => {
  const r = repos()
  try {
    const h = await harness(r, (input, id) => {
      write(input.cwd, { 'math.mjs': fix['math.mjs'], 'tests/fixtures/sum.json': '{"a":2,"b":3,"sum":5}', 'tests/math.test.mjs': "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { readFileSync } from 'node:fs'\nimport { add } from '../math.mjs'\nconst c = JSON.parse(readFileSync(new URL('./fixtures/sum.json', import.meta.url)))\ntest('add sums', () => assert.equal(add(c.a, c.b), c.sum))\n" })
      return { id, status: 'succeeded', result: 'Fix addition with fixture' }
    })
    h.fault(); h.api.sweepFaults(); await h.settle()
    assert.equal(h.faults.get('fp1').status, 'shipped', h.faults.get('fp1').note)
  } finally { r.done() }
})

test('a failing revert backs off and notifies the owner once', async () => {
  const r = repos()
  try {
    const h = await harness(r, (input, id) => { write(input.cwd, fix); return { id, status: 'succeeded', result: 'Fix addition' } })
    h.fault(); h.api.sweepFaults(); await h.settle()
    lockLocal(r)
    h.kv.set('update:failedCommit', h.faults.get('fp1').commit)
    h.api.sweepFaults(); await h.settle()
    await later(h, 61_000)
    const attempts = () => h.audits.filter(a => a[2].startsWith('Could not revert')).length
    assert.equal(attempts(), 2)
    await later(h, 100_000)
    assert.equal(attempts(), 2, 'the second retry waits two minutes')
    assert.equal(h.sent.filter(s => s[2].includes('could not be reverted')).length, 1)
  } finally { r.done() }
})

test('empty discoveries back off until a proposal is found', async () => {
  const r = repos()
  try {
    const h = await harness(r, (_input, id) => ({ id, status: 'succeeded', result: proposal({ none: true }) }), { proactive: true, intervalHours: 1 })
    const discoveries = () => h.starts.filter(s => s.title.includes('Discover')).length
    h.api.sweepFaults(); await h.settle()
    assert.equal(discoveries(), 1)
    h.kv.set('self-repair:last-discovery', Date.now() - 1.5 * 3_600_000)
    h.api.sweepFaults(); await h.settle()
    assert.equal(discoveries(), 1, 'one empty result doubles the interval')
    h.kv.set('self-repair:last-discovery', Date.now() - 2.1 * 3_600_000)
    h.api.sweepFaults(); await h.settle()
    assert.equal(discoveries(), 2)
    assert.equal(h.kv.get('self-repair:discovery-idle'), 2)
  } finally { r.done() }
})
