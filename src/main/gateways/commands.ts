import { holdCompletion } from '../maintenance'
import { replyTarget } from '../reply-target'
import type { ProviderId, Run, RunTrigger } from '@shared/types'
import { randomUUID } from 'node:crypto'
import { cfg } from '../config'
import { deleteConversation, getConversation, kvGet, kvSet, listRuns } from '../db'
import { cancelRun, sendMessage, waitForRun } from '../runs'
import { isOwner } from '../profile-context'
import { applyUpdate } from '../updater'
import { answerApproval, rememberChat } from './approvals'
import { applyModelCommand, chatModel, copyChatModel, parseModelCommand, runModelCommand, splitModelPrefix } from '../model-commands'
import { parseTerminalCommand, runTerminalCommand } from '../chat-terminal'
import { cancelLogin, loginInstructions, loginListening, loginResultText, normalizeLoginCode, startLogin, submitLoginCode, waitingForClaudeCode } from '../provider-login'

interface Inbound {
  key: string
  text: string
  trigger: RunTrigger
  triggerRef: string
  provider?: ProviderId
  cwd?: string
  reply: (text: string) => Promise<void>
  onStart?: () => Promise<void>
  onDone?: () => Promise<void>
}

const ACTIVE = new Set(['queued', 'running', 'awaiting_approval'])

/**
 * Chat commands handled without a model. Bare words count in capitals ("STOP", not "stop") so ordinary words still
 * reach the agent; NEW and STOP also accept a phone's autocapitalized "New"/"Stop", since a message that is only that
 * word means the command. The slash forms are explicit and accept any case.
 */
export const COMMANDS = {
  update: (t: string) => /^UPDATE[.!]*$/.test(t) || /^[/!]update$/i.test(t),
  stop: (t: string) => /^(?:STOP|Stop)[.!]*$/.test(t) || /^[/!]stop$/i.test(t),
  reset: (t: string) => /^(?:NEW|New)[.!]*$/.test(t) || /^[/!](?:new|reset)$/i.test(t),
  /** "NEW <text>": a fresh session that starts with <text>. */
  fresh: (t: string) => /^NEW\s+([\s\S]+)$/.exec(t)?.[1].trim() ?? null
}

function activeRuns(key: string): Run[] {
  return [...ACTIVE].flatMap((status) => listRuns({ conversationKey: key, status: status as Run['status'], limit: -1 }))
}

/** Cancels the conversation's active runs; returns how many there were. */
export function stopConversation(key: string): number {
  const running = activeRuns(key)
  for (const r of running) cancelRun(r.id)
  return running.length
}

/**
 * An iMessage or Slack chat is one long line, but each NEW opens a new thread in it, so the app lists every session
 * separately: `imessage:<chat>` is the first thread, `imessage:<chat>#<id>` the later ones. App threads are already
 * separate chats, so NEW in the app opens a new one.
 */
export const chatOfThread = (key: string): string => key.replace(/#[a-z0-9]+$/, '')
const threadPointer = (chat: string) => `chat:thread:${chat}`

/** The thread a gateway chat's next message belongs to. */
export function currentThread(chat: string): string {
  return kvGet<string>(threadPointer(chat)) ?? chat
}

/** NEW: stops this thread and returns a new one with no session or recap; the chat's model switch carries over. */
export function startNewThread(key: string): string {
  stopConversation(key)
  const chat = chatOfThread(key)
  const next = chat.startsWith('ui:') ? `ui:${randomUUID()}` : `${chat}#${randomUUID().replaceAll('-', '')}`
  if (!chat.startsWith('ui:')) kvSet(threadPointer(chat), next)
  copyChatModel(key, next)
  return next
}

/** After idleResetMinutes without a turn, the next message starts a new session that carries a recap of the old one. */
export function resetIfIdle(key: string): boolean {
  const minutes = cfg().gateways.idleResetMinutes
  if (!minutes || !getConversation(key) || activeRuns(key).length) return false
  const last = listRuns({ conversationKey: key, limit: 1 })[0]
  const at = last ? (last.finishedAt ?? last.createdAt) : 0
  if (!at || Date.now() - at <= minutes * 60_000) return false
  deleteConversation(key)
  return true
}

const idleSpan = (minutes: number) => minutes % 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes === 60 ? '' : 's'}`

export async function handleInbound(msg: Inbound): Promise<void> {
  const release = holdCompletion()
  try { await handleMessage(msg) } finally { release() }
}

/**
 * A chat command's outcome: an answer with no model run, or the prompt to run plus notices to show first.
 * `key` is set when NEW moved the chat to a new thread; the prompt, if any, runs there.
 */
export type ChatTurn = ({ reply: string; notice?: true } | { prompt: string; notices: string[]; switched?: true }) & { key?: string }

interface ChatCommandInput {
  key: string
  text: string
  trigger: RunTrigger
  /** Where late results (a finished sign-in) are reported. */
  reply: (text: string) => Promise<void>
}

/**
 * Every chat command, for iMessage, Slack and the app's chat alike, so a command typed anywhere never reaches a model.
 * `notice` marks the answers the app shows as a toast (NEW, STOP) rather than as a turn in the thread.
 */
export async function interpretChat(msg: ChatCommandInput): Promise<ChatTurn> {
  const text = msg.text.trim()
  // Codes must never reach a model or its transcript, even after a restart lost the waiting PKCE process.
  const code = normalizeLoginCode(text)
  if (code) {
    if (!waitingForClaudeCode()) return { reply: 'No Claude sign-in is waiting here. The previous link expired or Jarvis restarted. Send /connect claude for a new link.' }
    try {
      // A /connect from this chat already reports the result through its listener.
      const reported = loginListening('claude', `chat:${msg.key}`)
      const info = await submitLoginCode(code)
      return { reply: reported ? '' : loginResultText(info) }
    } catch (err) {
      return { reply: `⚠️ ${(err as Error).message}` }
    }
  }
  // TERMINAL mode types every message into a shell, so it outranks the commands below.
  const terminal = parseTerminalCommand(msg.key, text)
  if (terminal) return { reply: isOwner() ? await runTerminalCommand(msg.key, terminal).catch((err) => `⚠️ ${(err as Error).message}`) : 'Only the owner can use the terminal.' }
  if (COMMANDS.update(text)) {
    if (!isOwner()) return { reply: 'Only the owner can update the app.' }
    await msg.reply('I’m checking for an update. If available, a separate worker will prepare it while Jarvis stays usable. I’ll report the result here after it installs or rolls back.')
    try {
      const update = await applyUpdate({ actor: 'user', reply: replyTarget({ trigger: msg.trigger, conversationKey: msg.key }) ?? undefined })
      // Queuing returns immediately; the durable job owns the later completion report.
      if (update.state === 'installing') return { reply: '' }
      return { reply: update.state === 'idle' ? 'Jarvis is already up to date.'
        : update.state === 'error' ? `⚠️ Update failed: ${update.message ?? 'Unknown error'}`
        : `${update.message ?? 'An update is already in progress.'}${update.jobId ? ` (job ${update.jobId.slice(0, 8)})` : ''}` }
    } catch (err) {
      return { reply: `⚠️ Update failed: ${(err as Error).message}` }
    }
  }
  const connect = /^\/connect(?:\s+(claude|codex|chatgpt|cancel))?$/i.exec(text)
  if (connect) {
    const arg = connect[1]?.toLowerCase()
    if (arg === 'cancel') {
      const cancelled = (['claude', 'codex'] as const).map((p) => cancelLogin(p)).filter((l) => l?.state === 'cancelled')
      return { reply: cancelled.length ? 'Sign-in cancelled.' : 'No sign-in is waiting.' }
    }
    const provider = arg === 'codex' || arg === 'chatgpt' ? 'codex' : 'claude'
    try {
      const info = await startLogin(provider, { key: `chat:${msg.key}`, fn: (done) => void msg.reply(loginResultText(done)).catch(() => undefined) })
      return { reply: loginInstructions(info) }
    } catch (err) {
      return { reply: `⚠️ ${(err as Error).message}` }
    }
  }
  const modelCommand = parseModelCommand(text)
  if (modelCommand) return { reply: await runModelCommand(msg.key, modelCommand).catch((err) => `⚠️ ${(err as Error).message}`) }
  if (COMMANDS.stop(text)) return { reply: stopConversation(msg.key) ? 'Stopped.' : 'Nothing is running.', notice: true }
  if (COMMANDS.reset(text)) return { reply: 'New chat started.', notice: true, key: startNewThread(msg.key) }
  const notices: string[] = []
  let prompt = text
  let key = msg.key
  const fresh = COMMANDS.fresh(text)
  if (fresh) {
    key = startNewThread(msg.key)
    notices.push('New chat started.')
    prompt = fresh
  } else if (resetIfIdle(msg.key)) {
    notices.push(`New session: it’s been over ${idleSpan(cfg().gateways.idleResetMinutes)} since we last talked, so I started fresh with a short recap of that chat. Send NEW to start without one.`)
  }
  // "CLAUDE OPUS <request>": switch, then run the request on the new model.
  const thread = key === msg.key ? {} : { key }
  const prefixed = await splitModelPrefix(prompt).catch(() => null)
  if (prefixed) {
    const { text: switched, switched: ok } = await applyModelCommand(key, prefixed.command).catch((err) => ({ text: `⚠️ ${(err as Error).message}`, switched: false }))
    if (!ok) return { reply: switched, ...thread }
    notices.push(switched.replace(/ It applies from your next message/, ' It applies from this message'))
    return { prompt: prefixed.prompt, notices, switched: true, ...thread }
  }
  return { prompt, notices, ...thread }
}

async function handleMessage(inbound: Inbound): Promise<void> {
  const text = inbound.text.trim()
  if (!text) return
  // Gateways name the chat; its runs, approvals and commands belong to the chat's current thread.
  const msg = { ...inbound, key: currentThread(inbound.key) }
  rememberChat(msg.key, msg.reply)
  // An answer to an approval asked in this chat settles it; it is not a message for the agent.
  const answered = answerApproval(msg.key, text, msg.trigger === 'slack' ? 'Slack' : 'iMessage')
  if (answered) {
    await msg.reply(answered)
    return
  }
  const turn = await interpretChat({ key: msg.key, text, trigger: msg.trigger, reply: msg.reply })
  if ('reply' in turn) {
    if (turn.reply) await msg.reply(turn.reply)
    return
  }
  for (const notice of turn.notices) await msg.reply(notice)
  const prompt = turn.prompt
  const key = turn.key ?? msg.key
  if (turn.key) rememberChat(key, msg.reply)
  let done: Run
  let ownsReply = false
  try {
    // A model switch made in this chat (CLAUDE OPUS, CODEX SOL…) outranks the gateway's configured agent.
    const pref = chatModel(key)
    const { run, steered } = await sendMessage({ prompt, provider: pref?.provider ?? msg.provider, model: pref?.model, effort: pref?.effort, cwd: msg.cwd, trigger: msg.trigger, triggerRef: msg.triggerRef, conversationKey: key })
    // The original inbound handler owns the final reply for a steered run.
    if (steered) return
    ownsReply = true
    // Queue before awaiting a typing indicator: STOP must see this run immediately.
    await msg.onStart?.().catch(() => undefined)
    done = await waitForRun(run.id)
  } catch (err) {
    await msg.reply(`⚠️ failed: ${(err as Error).message}`)
    return
  } finally {
    if (ownsReply) await msg.onDone?.().catch(() => undefined)
  }
  if (done.status === 'cancelled') return
  await msg.reply(done.status === 'succeeded' ? done.result || '(done)' : `⚠️ ${done.status}${done.error ? `: ${done.error}` : ''}`)
}
