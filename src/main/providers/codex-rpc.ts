import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { AsyncQueue } from './steering'

interface RpcNotification { method: string; params: Record<string, any> }

/** One local app-server per run; stdin/stdout never leave this machine. */
export class CodexRpc {
  readonly events = new AsyncQueue<RpcNotification>()
  private child: ChildProcessWithoutNullStreams
  private nextId = 0
  private closed = false
  private stderrTail = ''
  private pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>()
  /** Answers the app-server's own requests (approvals). Returning undefined refuses one Jarvis has no answer for. */
  onRequest?: (method: string, params: Record<string, any>) => Promise<unknown>
  /** Sees every notification as it is read, before any request that follows it is answered (the event queue lags behind). */
  onNotification?: (msg: RpcNotification) => void

  constructor(bin: string, env: Record<string, string>, cwd: string) {
    this.child = spawn(bin, ['app-server', '-c', 'forced_login_method="chatgpt"'], { env, cwd, stdio: 'pipe' })
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', (line) => {
      // The app-server speaks JSON-RPC on stdout; anything else (a stray log line) is not a protocol error.
      if (!line.trimStart().startsWith('{')) return
      try {
        const msg = JSON.parse(line)
        if (msg.method && msg.id !== undefined) {
          void this.answer(msg.id, msg.method, msg.params ?? {})
        } else if (msg.id !== undefined) {
          const p = this.pending.get(msg.id)
          if (!p) return
          this.pending.delete(msg.id)
          clearTimeout(p.timer)
          if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`))
          else p.resolve(msg.result)
        } else if (msg.method && !this.closed) {
          this.onNotification?.(msg)
          this.events.push(msg)
        }
      } catch (err) {
        this.fail(new Error(`Invalid Codex app-server message: ${String(err)}`))
      }
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-2000) })
    this.child.stdin.on('error', (err) => this.fail(err))
    this.child.on('error', (err) => this.fail(new Error(`Could not start Codex app-server: ${err.message}`)))
    this.child.on('close', (code) => {
      lines.close()
      if (!this.closed) this.fail(new Error(`Codex app-server exited (${code}) before the turn completed${this.stderrDetail()}`))
    })
  }

  private async answer(id: number | string, method: string, params: Record<string, any>): Promise<void> {
    let reply: unknown
    try {
      const result = await this.onRequest?.(method, params)
      reply = result === undefined ? { id, error: { code: -32601, message: `${method} is not supported by Jarvis` } } : { id, result }
    } catch (err) {
      reply = { id, error: { code: -32603, message: (err as Error).message } }
    }
    // The run may have ended while a person was deciding; there is nobody left to answer.
    if (!this.closed) try { this.write(reply) } catch { /* closed meanwhile */ }
  }

  private stderrDetail(): string {
    const tail = this.stderrTail.trim().split('\n').filter(Boolean).slice(-3).join(' | ')
    return tail ? `: ${tail.slice(-500)}` : ''
  }

  private write(msg: unknown): void {
    if (this.closed) throw new Error('Codex app-server is closed')
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex ${method} timed out; delivery is unknown. Check the run before resending.`))
      }, 60_000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ id, method, params }) } catch (err) { this.fail(err as Error) }
    })
  }

  notify(method: string, params: unknown): void { this.write({ method, params }) }

  private fail(err: Error): void {
    if (this.closed) return
    this.close(err)
  }

  /** Without an error the event stream ends normally; with one, readers see why the server went away. */
  close(err?: Error): void {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err ?? new Error('Codex app-server closed')) }
    this.pending.clear()
    this.events.end(err)
    try { this.child.stdin.end() } catch { /* already gone */ }
    this.child.kill('SIGTERM')
    const kill = setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGKILL') }, 3000)
    kill.unref()
    this.child.once('close', () => clearTimeout(kill))
  }
}
