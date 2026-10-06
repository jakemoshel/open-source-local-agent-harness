import type { MeetingInput } from '../meetings'

/** A Slack message event as delivered to a meeting-notes channel (Granola posts as a bot). */
export interface SlackNoteMessage {
  channel: string
  ts: string
  thread_ts?: string
  text?: string
  user?: string
  bot_id?: string
  subtype?: string
  blocks?: unknown[]
  attachments?: { title?: string; title_link?: string; pretext?: string; text?: string; fields?: { title?: string; value?: string }[] }[]
  message?: SlackNoteMessage
}

type Node = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const textObj = (v: unknown): string => str((v as Node | undefined)?.text)

function inline(elements: unknown): string {
  if (!Array.isArray(elements)) return ''
  return elements.map((e: Node) => {
    if (e.type === 'link') return str(e.text) ? `[${str(e.text)}](${str(e.url)})` : str(e.url)
    if (e.type === 'emoji') return `:${str(e.name)}:`
    if (e.type === 'user') return `<@${str(e.user_id)}>`
    if (e.type === 'text' && (e.style as Node | undefined)?.bold && str(e.text).trim()) return `**${str(e.text)}**`
    return str(e.text)
  }).join('')
}

function richText(el: Node, depth = 0): string {
  switch (el.type) {
    case 'rich_text_section': return inline(el.elements)
    case 'rich_text_preformatted': return '```\n' + inline(el.elements) + '\n```'
    case 'rich_text_quote': return '> ' + inline(el.elements)
    case 'rich_text_list': {
      const indent = '  '.repeat(Number(el.indent ?? 0))
      return (el.elements as Node[] ?? []).map((item, i) => `${indent}${el.style === 'ordered' ? `${i + 1}.` : '-'} ${richText(item, depth + 1)}`).join('\n')
    }
    default: return ''
  }
}

/** Flatten Slack Block Kit into Markdown-ish text, keeping the wording exactly as posted. */
function blocksToText(blocks: unknown[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  const out: string[] = []
  for (const b of blocks as Node[]) {
    if (b.type === 'header') out.push(`# ${textObj(b.text)}`)
    else if (b.type === 'section') {
      if (textObj(b.text)) out.push(textObj(b.text))
      if (Array.isArray(b.fields)) out.push((b.fields as unknown[]).map(textObj).filter(Boolean).join('\n'))
    } else if (b.type === 'context') out.push((b.elements as unknown[] ?? []).map(textObj).filter(Boolean).join(' '))
    else if (b.type === 'rich_text') out.push((b.elements as Node[] ?? []).map((e) => richText(e)).join('\n'))
    else if (b.type === 'markdown') out.push(str(b.text))
  }
  return out.map((s) => s.trim()).filter(Boolean).join('\n\n')
}

function attachmentsToText(atts: SlackNoteMessage['attachments']): string {
  if (!Array.isArray(atts)) return ''
  return atts.map((a) => [
    a.pretext, a.title && (a.title_link ? `[${a.title}](${a.title_link})` : a.title), a.text,
    ...(a.fields ?? []).map((f) => [f.title, f.value].filter(Boolean).join(': '))
  ].filter(Boolean).join('\n')).filter(Boolean).join('\n\n')
}

/** The full posted text: blocks if present (richest), otherwise the plain text, plus attachments. */
export function slackNoteText(m: SlackNoteMessage): string {
  const body = blocksToText(m.blocks) || str(m.text)
  return [body, attachmentsToText(m.attachments)].map((s) => s.trim()).filter(Boolean).join('\n\n')
}

const GRANOLA_URL = /https?:\/\/(?:notes\.)?granola\.(?:ai|so)\/[^\s|>)]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

function titleFrom(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').replace(/\*+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^|>]*\|([^>]*)>/g, '$1').replace(/<[^>]*>/g, '').trim()
    if (line) return line.slice(0, 200)
  }
  return 'Untitled meeting'
}

const slackTsToIso = (ts: string): string => new Date(Math.round(Number(ts) * 1000)).toISOString()

export const meetingIdFor = (m: SlackNoteMessage): string => `slack:${m.channel}:${m.thread_ts ?? m.ts}`
export const granolaNoteId = (text: string): string | null => GRANOLA_URL.exec(text)?.[1]?.toLowerCase() ?? null

/**
 * Turn a Slack post into a meeting archive record, one record per Slack thread so edits and
 * thread replies land together. Pass the existing summary for a thread reply to append to it.
 */
export function slackNoteToMeeting(m: SlackNoteMessage, existing?: { title: string; date: string; summary: string } | null): MeetingInput | null {
  const text = slackNoteText(m)
  if (!text) return null
  const isReply = !!m.thread_ts && m.thread_ts !== m.ts
  if (isReply && existing) {
    if (existing.summary.includes(text)) return null
    return { id: meetingIdFor(m), title: existing.title, date: existing.date, summary: `${existing.summary.trimEnd()}${REPLY_SEP}${text}\n` }
  }
  // Root post (new or edited): replace the root text but keep any thread replies already archived.
  const sep = existing?.summary.indexOf(REPLY_SEP) ?? -1
  const replies = existing && sep >= 0 ? existing.summary.slice(sep) : ''
  return { id: meetingIdFor(m), title: titleFrom(text), date: slackTsToIso(m.thread_ts ?? m.ts), summary: replies ? `${text}${replies}` : `${text}\n` }
}

const REPLY_SEP = '\n\n---\n\n'

/** Normalise edits (message_changed) to the edited message; drop deletions and other noise. */
export function unwrapSlackEvent(m: SlackNoteMessage): SlackNoteMessage | null {
  if (m.subtype === 'message_changed' && m.message) return { ...m.message, channel: m.channel }
  if (m.subtype && m.subtype !== 'bot_message' && m.subtype !== 'thread_broadcast') return null
  return m
}
