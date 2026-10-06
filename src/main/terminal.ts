import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { defaultCwd } from './config'
import { agentEnv } from './env'
import { expandHome } from './paths'

/**
 * Persistent terminals for the owner and their agents: real PTY shells that outlive a single run, so an agent can
 * start a server, an ssh session or a long build, come back to it from a later run, and answer interactive prompts.
 * A tiny Python relay allocates the PTY (Python ships with the Command Line Tools that Jarvis already needs for git),
 * which avoids a native Node module that would have to be rebuilt for every Electron upgrade.
 */
export const RELAY = `
import os, pty, sys, select, fcntl, termios, struct, signal
cols, rows = int(sys.argv[1]), int(sys.argv[2])
argv = sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    os.execvp(argv[0], argv)
def stop(*_):
    try: os.kill(pid, signal.SIGHUP)
    except OSError: pass
    sys.exit(143)
signal.signal(signal.SIGTERM, stop)
inp, out, open_in = sys.stdin.fileno(), sys.stdout.fileno(), True
while True:
    r, _, _ = select.select([fd] + ([inp] if open_in else []), [], [])
    if fd in r:
        try: data = os.read(fd, 65536)
        except OSError: data = b''
        if not data: break
        os.write(out, data)
    if open_in and inp in r:
        data = os.read(inp, 65536)
        if not data:
            open_in = False
            try: os.kill(pid, signal.SIGHUP)
            except OSError: pass
        else: os.write(fd, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`

const COLS = 160
const ROWS = 48
const MAX_BUFFER = 512 * 1024
const MAX_OPEN = 12
const MAX_EXITED = 20

interface Session {
  id: string
  name: string
  cwd: string
  child: ChildProcessWithoutNullStreams
  /** Raw output tail; `end` is the absolute offset of its last character, so readers can resume with a cursor. */
  buffer: string
  end: number
  startedAt: number
  lastOutputAt: number
  exitedAt: number | null
  exitCode: number | null
}

export interface TerminalInfo {
  id: string
  name: string
  cwd: string
  running: boolean
  pid: number | null
  startedAt: number
  lastOutputAt: number
  exitCode: number | null
  cursor: number
}

const sessions = new Map<string, Session>()
let nextTerminalNumber = 1

const KEYS: Record<string, string> = {
  enter: '\r', tab: '\t', esc: '\x1b', backspace: '\x7f', space: ' ',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  'ctrl-c': '\x03', 'ctrl-d': '\x04', 'ctrl-z': '\x1a', 'ctrl-l': '\x0c', 'ctrl-a': '\x01', 'ctrl-e': '\x05', 'ctrl-u': '\x15', 'ctrl-r': '\x12'
}

// CSI, OSC, charset and single-character escapes, plus bracketed-paste toggles.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>NOM78c]/g

/** Terminal output as a person would read it: no escape codes, carriage-return overwrites and backspaces applied. */
export function cleanOutput(raw: string): string {
  const text = raw.replace(ANSI, '').replace(/\r+\n/g, '\n')
  return text
    .split('\n')
    .map((line) => {
      // Only the last carriage-return segment survives, including an empty one.
      let output = line.slice(line.lastIndexOf('\r') + 1)
      if (output.includes('\b')) {
        const chars: string[] = []
        // Preserve the old UTF-16 code-unit behavior and keep controls until after erasure.
        for (let i = 0; i < output.length; i++) {
          const char = output[i]
          if (char === '\b') chars.pop()
          else chars.push(char)
        }
        output = chars.join('')
      }
      return output.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\s+$/, '')
    })
    .join('\n')
}

function info(s: Session): TerminalInfo {
  return { id: s.id, name: s.name, cwd: s.cwd, running: s.exitedAt === null, pid: s.child.pid ?? null, startedAt: s.startedAt, lastOutputAt: s.lastOutputAt, exitCode: s.exitCode, cursor: s.end }
}

function get(id: string): Session {
  const exact = sessions.get(id)
  if (exact) return exact
  let latest: Session | undefined
  // Map insertion order tracks opening order, even when timestamps tie or the clock changes.
  for (const s of sessions.values()) {
    if (s.name !== id) continue
    if (s.exitedAt === null) return s
    latest = s
  }
  if (!latest) throw new Error(`No terminal "${id}". terminal_list shows open terminals.`)
  return latest
}

function pruneExited(): void {
  const exited = [...sessions.values()].filter((s) => s.exitedAt !== null).sort((a, b) => a.exitedAt! - b.exitedAt!)
  for (const s of exited.slice(0, Math.max(0, exited.length - MAX_EXITED))) sessions.delete(s.id)
}

export function listTerminals(): TerminalInfo[] {
  return [...sessions.values()].sort((a, b) => b.startedAt - a.startedAt).map(info)
}

export async function openTerminal(opts: { name?: string; cwd?: string; command?: string; waitMs?: number } = {}): Promise<TerminalInfo & { output: string }> {
  const running = [...sessions.values()].filter((s) => s.exitedAt === null)
  if (running.length >= MAX_OPEN) throw new Error(`${MAX_OPEN} terminals are already open; close one first (terminal_close).`)
  let name = opts.name?.trim().slice(0, 40) || ''
  if (!name) {
    // History can shrink; automatic numbering must not. Explicit names can reserve a candidate too.
    do { name = `term-${nextTerminalNumber++}` } while (running.some((s) => s.name === name))
  } else if (running.some((s) => s.name === name)) {
    throw new Error(`A terminal named "${name}" is already open`)
  }
  const wanted = opts.cwd ? expandHome(opts.cwd) : defaultCwd()
  const cwd = existsSync(wanted) ? wanted : defaultCwd()
  const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
  const env = { ...agentEnv(), TERM: 'xterm-256color', COLUMNS: String(COLS), LINES: String(ROWS), TERM_PROGRAM: 'MacMiniJarvis' }
  const child = spawn('/usr/bin/python3', ['-u', '-c', RELAY, String(COLS), String(ROWS), shell, '-il'], { cwd, env, stdio: 'pipe' })
  const s: Session = { id: randomUUID().slice(0, 8), name, cwd, child, buffer: '', end: 0, startedAt: Date.now(), lastOutputAt: Date.now(), exitedAt: null, exitCode: null }
  const append = (chunk: string) => {
    s.buffer += chunk
    s.end += chunk.length
    if (s.buffer.length > MAX_BUFFER) s.buffer = s.buffer.slice(-MAX_BUFFER)
    s.lastOutputAt = Date.now()
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  child.stdin.on('error', () => undefined)
  child.on('error', (err) => {
    s.exitedAt = Date.now()
    append(`\n[terminal failed to start: ${err.message}]\n`)
    pruneExited()
  })
  child.on('exit', (code, signal) => {
    s.exitedAt = Date.now()
    s.exitCode = code ?? (signal ? 128 : null)
    append(`\n[process exited${code !== null ? ` with code ${code}` : signal ? ` (${signal})` : ''}]\n`)
    pruneExited()
  })
  sessions.set(s.id, s)
  const { output } = opts.command
    ? await sendToTerminal(s.id, { input: opts.command, waitMs: opts.waitMs ?? 3000 })
    : await readAfter(s, 0, opts.waitMs ?? 800)
  return { ...info(s), output }
}

async function readAfter(s: Session, from: number, waitMs: number, until?: RegExp, idleMs = 700): Promise<{ output: string; cursor: number; matched: boolean }> {
  const deadline = Date.now() + Math.min(Math.max(waitMs, 0), 120_000)
  let matched = false
  let checkedEnd = -1
  for (;;) {
    // Cleaning up to 512 KB of output is the costly part: only redo it for a pattern, and only when output grew.
    if (until && s.end !== checkedEnd) {
      checkedEnd = s.end
      if (until.test(cleanOutput(slice(s, from).text))) { matched = true; break }
    }
    const quiet = Date.now() - s.lastOutputAt >= idleMs && s.end > from
    if (Date.now() >= deadline || s.exitedAt !== null || (!until && quiet)) break
    await new Promise((r) => setTimeout(r, 100))
  }
  const out = slice(s, from)
  return { output: out.text ? cleanOutput(out.text) : '', cursor: s.end, matched }
}

function slice(s: Session, from: number): { text: string; truncated: boolean } {
  const start = s.end - s.buffer.length
  if (from >= s.end) return { text: '', truncated: false }
  if (from < start) return { text: s.buffer, truncated: true }
  return { text: s.buffer.slice(from - start), truncated: false }
}

export async function sendToTerminal(id: string, opts: { input?: string; keys?: string[]; enter?: boolean; waitMs?: number; until?: string }): Promise<{ output: string; cursor: number; running: boolean; matched: boolean }> {
  const s = get(id)
  if (s.exitedAt !== null) throw new Error(`Terminal "${s.name}" has exited (code ${s.exitCode}); open a new one.`)
  let data = opts.input ?? ''
  if (opts.input !== undefined && opts.enter !== false) data += '\r'
  for (const k of opts.keys ?? []) {
    const seq = KEYS[k.toLowerCase()]
    if (!seq) throw new Error(`Unknown key "${k}". Use: ${Object.keys(KEYS).join(', ')}`)
    data += seq
  }
  const from = s.end
  let until: RegExp | undefined
  try {
    until = opts.until ? new RegExp(opts.until, 'm') : undefined
  } catch (err) {
    throw new Error(`Invalid until pattern: ${(err as Error).message}`)
  }
  // Validate everything before sending: a bad wait pattern must not execute a command.
  s.child.stdin.write(data)
  const r = await readAfter(s, from, opts.waitMs ?? 2000, until)
  return { ...r, running: s.exitedAt === null }
}

export async function readTerminal(id: string, opts: { since?: number; maxChars?: number; waitMs?: number; raw?: boolean } = {}): Promise<TerminalInfo & { output: string; truncated: boolean }> {
  const s = get(id)
  const from = opts.since ?? Math.max(0, s.end - 20_000)
  if (opts.waitMs && from >= s.end) await readAfter(s, from, opts.waitMs)
  const part = slice(s, from)
  let text = opts.raw ? part.text : cleanOutput(part.text)
  const max = opts.maxChars ?? 12_000
  let truncated = part.truncated
  if (text.length > max) {
    text = text.slice(-max)
    truncated = true
  }
  return { ...info(s), output: text, truncated }
}

export function closeTerminal(id: string): TerminalInfo {
  const s = get(id)
  if (s.exitedAt === null) {
    s.child.stdin.end()
    const term = setTimeout(() => s.exitedAt === null && s.child.kill('SIGTERM'), 1500)
    const kill = setTimeout(() => s.exitedAt === null && s.child.kill('SIGKILL'), 5000)
    term.unref()
    kill.unref()
  } else {
    sessions.delete(s.id)
  }
  return info(s)
}

export function closeAllTerminals(): void {
  for (const s of sessions.values()) {
    if (s.exitedAt !== null) continue
    try {
      s.child.stdin.end()
      s.child.kill('SIGTERM')
    } catch {
      // Already gone.
    }
  }
}
