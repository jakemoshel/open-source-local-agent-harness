import { audit } from './db'
import { closeTerminal, openTerminal, readTerminal, sendToTerminal } from './terminal'

/**
 * TERMINAL from a chat: a real shell driven by text, with no model call. Each chat gets its own persistent terminal
 * (the same PTY shells agents use), so `cd`, env vars and running programs carry over between messages.
 *   TERMINAL                    terminal mode: every message is typed into the shell until EXIT
 *   TERMINAL <cmd> · $ <cmd>    run one command without entering terminal mode
 * In terminal mode: EXIT closes the shell, READ shows output printed since the last reply, ^C (or STOP) ^D ^Z ^L send that key.
 * Bare words count only in capitals, like STOP and NEW; slash forms (/terminal, /term, /exit, /read) accept any case.
 */

interface ChatShell { id: string; cursor: number; mode: boolean; timer?: NodeJS.Timeout }

const shells = new Map<string, ChatShell>()
const opening = new Map<string, Promise<ChatShell>>()
/** An idle chat shell closes itself, so a forgotten terminal mode never swallows later messages meant for the agent. */
const IDLE_MS = 30 * 60_000
/** Long enough for most commands; a slower one keeps running and READ fetches the rest. */
const WAIT_MS = 15_000
/** Keeps a reply within one text message; the newest output is the useful part. */
const MAX_REPLY = 3500
const KEYS: Record<string, string> = { STOP: 'ctrl-c', '^C': 'ctrl-c', '^D': 'ctrl-d', '^Z': 'ctrl-z', '^L': 'ctrl-l', 'CTRL-C': 'ctrl-c', 'CTRL-D': 'ctrl-d', 'CTRL-Z': 'ctrl-z', 'CTRL-L': 'ctrl-l' }

export type TerminalCommand =
  | { kind: 'enter' }
  | { kind: 'exit' }
  | { kind: 'read' }
  | { kind: 'key'; key: string }
  | { kind: 'run'; input: string }

export function inTerminalMode(key: string): boolean {
  return shells.get(key)?.mode ?? false
}

/** Outside terminal mode only TERMINAL and its one-shot forms match, so ordinary messages still reach the agent. */
export function parseTerminalCommand(key: string, text: string): TerminalCommand | null {
  const t = text.trim()
  if (/^TERMINAL[.!]*$/.test(t) || /^[/!](?:terminal|term)$/i.test(t)) return { kind: 'enter' }
  // "$ <cmd>" needs the space, so "$50 for lunch?" still reaches the agent.
  const once = /^TERMINAL\s+([\s\S]+)$/.exec(t) ?? /^[/!](?:terminal|term)\s+([\s\S]+)$/i.exec(t) ?? /^\$\s+([\s\S]+)$/.exec(t)
  if (once) return { kind: 'run', input: once[1].trim() }
  if (!inTerminalMode(key)) return null
  if (/^EXIT[.!]*$/.test(t) || /^[/!]exit$/i.test(t)) return { kind: 'exit' }
  if (/^READ[.!]*$/.test(t) || /^[/!]read$/i.test(t)) return { kind: 'read' }
  const k = KEYS[t.toUpperCase()]
  if (k) return { kind: 'key', key: k }
  return { kind: 'run', input: t }
}

function close(key: string): void {
  const shell = shells.get(key)
  if (!shell) return
  clearTimeout(shell.timer)
  shells.delete(key)
  try { closeTerminal(shell.id) } catch { /* already gone */ }
}

function touch(key: string, shell: ChatShell): void {
  clearTimeout(shell.timer)
  shell.timer = setTimeout(() => close(key), IDLE_MS)
  shell.timer.unref()
}

/** A fenced block keeps shell output verbatim on iMessage and Slack; the typed command echoed back is dropped. */
function format(output: string, input?: string): string {
  let lines = output.split('\n')
  if (input !== undefined && lines[0]?.trimEnd().endsWith(input.split('\n')[0])) lines = lines.slice(1)
  let text = lines.join('\n').replace(/^\n+|\s+$/g, '')
  if (text.length > MAX_REPLY) text = `…${text.slice(-MAX_REPLY)}`
  return text ? '```\n' + text.replaceAll('```', '`​``') + '\n```' : '(no output yet; READ checks again)'
}

async function shellFor(key: string, mode: boolean): Promise<ChatShell> {
  const existing = shells.get(key)
  if (existing) {
    existing.mode ||= mode
    return existing
  }
  // Share startup across overlapping messages; only one PTY may belong to a chat.
  let pending = opening.get(key)
  if (!pending) {
    pending = openTerminal({ name: `chat-${key.replace(/[^\w-]+/g, '-').slice(-30)}-${Date.now().toString(36).slice(-4)}`, waitMs: 1500 })
      .then((t) => {
        const shell: ChatShell = { id: t.id, cursor: t.cursor, mode }
        shells.set(key, shell)
        return shell
      }).finally(() => opening.delete(key))
    opening.set(key, pending)
  }
  const shell = await pending
  shell.mode ||= mode
  return shell
}

/** Runs one terminal command for a chat and returns the reply. Owner-only: the caller checks before calling. */
export async function runTerminalCommand(key: string, cmd: TerminalCommand): Promise<string> {
  if (cmd.kind === 'exit') {
    close(key)
    return 'Terminal closed. Messages go to Jarvis again.'
  }
  if (cmd.kind === 'enter') {
    const reused = shells.has(key)
    const shell = await shellFor(key, true)
    touch(key, shell)
    return `Terminal mode${reused ? ' (same shell as before)' : ''}: every message now runs in a shell on the Mac mini, no AI. EXIT closes it, READ shows new output, ^C interrupts. It closes itself after 30 idle minutes.`
  }
  const shell = shells.get(key)
  if (cmd.kind === 'read') {
    if (!shell) return 'No terminal is open.'
    const r = await readTerminal(shell.id, { since: shell.cursor, maxChars: MAX_REPLY })
    shell.cursor = r.cursor
    touch(key, shell)
    if (!r.running) close(key)
    return format(r.output) + (r.running ? '' : '\n(shell exited; terminal mode ended)')
  }
  const s = await shellFor(key, false)
  touch(key, s)
  if (cmd.kind === 'run') audit('user', 'terminal', `Chat terminal ${key}: ${cmd.input.slice(0, 200)}`)
  try {
    const r = await sendToTerminal(s.id, cmd.kind === 'key' ? { keys: [cmd.key], waitMs: 2000 } : { input: cmd.input, waitMs: WAIT_MS })
    s.cursor = r.cursor
    if (!r.running) close(key)
    return format(r.output, cmd.kind === 'run' ? cmd.input : undefined) + (r.running ? '' : '\n(shell exited; terminal mode ended)')
  } catch (err) {
    // A shell that died between messages: forget it so the next command opens a fresh one.
    close(key)
    throw err
  }
}
