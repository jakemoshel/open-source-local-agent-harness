import type { Approval } from '@shared/types'
import { bus } from '../bus'
import { getRun } from '../db'
import { isOwner, profileId } from '../profile-context'
import { resolveApproval } from '../runs'
import { allowAlwaysRule, subjectOf } from '../safeguards'

/**
 * Approvals for runs that came in over iMessage or Slack are asked in that same chat, and a short reply
 * (1 / 2 / 3, or yes / always / no) settles them without reaching the agent.
 */
type Reply = (text: string) => Promise<void>
const repliers = new Map<string, Reply>()
const asked = new Map<string, string[]>()
const chatOf = (key: string) => `${profileId()}:${key}`

/** Remember how to answer a chat; called for every inbound message so the latest route is used. */
export function rememberChat(key: string, reply: Reply): void {
  repliers.set(chatOf(key), reply)
}

function describe(a: Approval): string {
  const subject = subjectOf(a.tool, a.input)
  const what = a.tool.endsWith('harness_call') ? `Jarvis action: ${subject}`
    : a.tool === 'Bash' ? `Run: ${subject}`
    : `${a.tool}: ${subject}`
  return what.length > 500 ? `${what.slice(0, 500)}…` : what
}

function approvalPrompt(a: Approval, owner: boolean): string {
  const lines = [`🔐 Jarvis needs your OK:`, describe(a), '']
  if (owner) lines.push(`Reply 1 = Yes · 2 = Yes, and always allow ${allowAlwaysRule(a.tool, a.input).label} · 3 = No`)
  else lines.push('Reply 1 = Yes · 3 = No')
  return lines.join('\n')
}

type ApprovalAnswer = 'yes' | 'always' | 'no'

/** Only a message that is just the answer counts, so "yes, and also email Sam" still reaches the agent. */
export function parseApprovalAnswer(text: string): ApprovalAnswer | null {
  const t = text.trim().toLowerCase().replace(/[.!\s]+$/g, '').replace(/^option\s+/, '')
  if (/^(1|y|yes|yep|yeah|yup|ok|okay|approve|approved|allow|go|go ahead|do it|👍)$/.test(t)) return 'yes'
  if (/^(2|always|yes always|yes,? always( allow)?|always allow|allow always|yes and always( allow)?)$/.test(t)) return 'always'
  if (/^(3|n|no|nope|nah|deny|denied|don'?t|do not|👎)$/.test(t)) return 'no'
  return null
}

export function initApprovalPrompts(): void {
  bus.on('approval:update', (a: Approval) => {
    // Emitted inside the run's profile, so the chat key and database lookups below are that profile's.
    if (a.status !== 'pending') {
      for (const [chat, ids] of asked) {
        if (!ids.includes(a.id)) continue
        const rest = ids.filter((x) => x !== a.id)
        if (rest.length) asked.set(chat, rest)
        else asked.delete(chat)
      }
      return
    }
    const key = getRun(a.runId)?.conversationKey
    if (!key) return
    const chat = chatOf(key)
    const reply = repliers.get(chat)
    if (!reply) return
    asked.set(chat, [...(asked.get(chat) ?? []), a.id])
    void reply(approvalPrompt(a, isOwner())).catch(() => undefined)
  })
}

/** Settle the oldest approval asked in this chat when the message is an answer. Returns the reply to send, or null. */
export function answerApproval(key: string, text: string, via: string): string | null {
  const chat = chatOf(key)
  const waiting = asked.get(chat)
  if (!waiting?.length) return null
  let answer = parseApprovalAnswer(text)
  if (!answer) return null
  if (answer === 'always' && !isOwner()) answer = 'yes'
  const id = waiting[0]
  if (waiting.length > 1) asked.set(chat, waiting.slice(1))
  else asked.delete(chat)
  const result = resolveApproval(id, answer !== 'no', answer === 'always', via)
  const more = asked.get(chat)?.length ?? 0
  const tail = more ? `\n(${more} more waiting: reply again for the next one.)` : ''
  if (!result) return `That request already ended, so nothing changed.${tail}`
  if (answer === 'no') return `Okay, I won't do that.${tail}`
  return (result.allowedAlways ? `👍 Approved. I'll allow ${result.allowedAlways} from now on without asking.` : '👍 Approved.') + tail
}
