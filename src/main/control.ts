import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { dialog } from 'electron'
import { createServer, type Server } from 'node:net'
import { HARNESS_TOOL_DEFS, runHarnessTool } from './harness-tools'
import { paths } from './paths'
import type { Effort, ProviderId } from '@shared/types'
import { inRunProfile, runGate, runKind, startRun, waitForRun } from './runs'

let server: Server | null = null
let listening = false
let retry: NodeJS.Timeout | null = null
let retryDelay = 2000

export function controlListening(): boolean {
  return listening
}

export function startControlServer(): void {
  if (retry) clearTimeout(retry)
  retry = null
  try {
    if (existsSync(paths.socket)) unlinkSync(paths.socket)
  } catch (err) {
    console.error(`[jarvis] could not remove stale control socket: ${(err as Error).message}`)
  }
  server = createServer((sock) => {
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk) => {
      buf += chunk
      if (buf.length > 1_048_576) { sock.destroy(); return }
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        void handle(line)
          .then((out) => {
            let text: string
            try {
              text = JSON.stringify(out)
            } catch (err) {
              text = JSON.stringify({ id: out.id, error: `Result could not be serialized: ${(err as Error).message}` })
            }
            if (sock.writable) sock.write(text + '\n')
          })
          .catch(() => sock.destroy())
      }
    })
    sock.on('error', () => undefined)
  })
  server.on('error', (err) => {
    listening = false
    console.error(`[jarvis] control socket unavailable (Codex runs lose harness tools): ${err.message}; retrying`)
    server?.close()
    server = null
    // Retry with backoff: a stale socket or a slow previous instance must not leave Codex without harness tools.
    retry = setTimeout(startControlServer, retryDelay)
    retry.unref()
    retryDelay = Math.min(retryDelay * 2, 60_000)
  })
  server.listen(paths.socket, () => {
    try { chmodSync(paths.socket, 0o600) } catch { /* listening already; permissions come from the 0700 home */ }
    listening = true
    retryDelay = 2000
  })
}

/** One on-screen decision per app session; concurrent requests share it and a denial sticks, so nothing can nag. */
let benchDecision: Promise<boolean> | null = null
function benchAllowed(): Promise<boolean> {
  return (benchDecision ??= dialog.showMessageBox({
    type: 'warning', buttons: ['Deny', 'Allow until Jarvis restarts'], defaultId: 0, cancelId: 0,
    message: 'Allow the benchmark script to start agent runs?',
    detail: 'Something on this Mac asked to run benchmark tasks as you (scripts/bench.mjs). Deny unless you just started npm run bench.'
  }).then((r) => r.response === 1, () => false))
}

async function handle(line: string): Promise<{ id: unknown; result?: unknown; error?: string }> {
  let msg: { id?: unknown; op?: string; tool?: string; args?: Record<string, unknown>; runId?: string; token?: string }
  try {
    msg = JSON.parse(line)
  } catch {
    return { id: null, error: 'Invalid JSON' }
  }
  try {
    if (msg.op === '__tools') return { id: msg.id, result: HARNESS_TOOL_DEFS }
    if (msg.op === '__doctor') {
      if (msg.runId || msg.token) return { id: msg.id, error: 'Use the gated doctor operation' }
      const { formatDoctor, runDoctor } = await import('./doctor')
      const report = await runDoctor({ fix: !!msg.args?.fix })
      return { id: msg.id, result: msg.args?.json ? report : formatDoctor(report) }
    }
    if (msg.op === '__bench') {
      // Any same-user process can reach this socket, agent shells included, and omitting a run token proves nothing.
      // So a person must allow benchmarking on screen once per app session, and bench runs carry their own trigger:
      // never mistaken for the user speaking by memory capture or reflection.
      if (msg.runId || msg.token || !(await benchAllowed())) return { id: msg.id, error: 'Benchmark runs were not allowed in Jarvis' }
      const a = msg.args ?? {}
      if (typeof a.prompt !== 'string' || !a.prompt.trim()) return { id: msg.id, error: 'prompt is required' }
      const pick = (k: string) => (typeof a[k] === 'string' && a[k] ? (a[k] as string) : undefined)
      const run = startRun({
        prompt: a.prompt, cwd: pick('cwd'), title: pick('title'), model: pick('model'),
        provider: pick('provider') as ProviderId | undefined, effort: pick('effort') as Effort | undefined, trigger: 'bench'
      })
      return { id: msg.id, result: await waitForRun(run.id) }
    }
    if (msg.op === '__call') return await inRunProfile(msg.runId, msg.token, async () => {
      const tool = String(msg.tool)
      const args = msg.args ?? {}
      if (tool === 'harness_ops' && runKind(msg.runId!) === 'task') return { id: msg.id, result: await runHarnessTool(tool, args, msg.runId) }
      // Codex reaches harness tools through this socket, bypassing the provider hook, so gate here.
      const g = runGate(msg.runId)
      if (!g) return { id: msg.id, error: 'No active Jarvis run for this call' }
      const decision = await g.gate(`mcp__harness__${tool}`, args, g.signal)
      if (!decision.allow) return { id: msg.id, error: decision.message ?? 'Denied by safeguards' }
      return { id: msg.id, result: await runHarnessTool(tool, args, msg.runId) }
    })
    return { id: msg.id, error: 'Unknown request' }
  } catch (err) {
    return { id: msg.id, error: err instanceof Error ? err.message : String(err) }
  }
}

export function stopControlServer(): void {
  listening = false
  if (retry) clearTimeout(retry)
  retry = null
  server?.close()
  server = null
  try {
    if (existsSync(paths.socket)) unlinkSync(paths.socket)
  } catch {
    // Removed on next start.
  }
}
