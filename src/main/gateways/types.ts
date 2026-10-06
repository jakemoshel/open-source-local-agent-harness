import type { GatewayStatus } from '@shared/types'

export interface Gateway {
  name: GatewayStatus['name']
  status: GatewayStatus
  start(): Promise<void>
  stop(): Promise<void>
  send(target: string, text: string): Promise<void>
}

export function chunk(text: string, size: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size / 2) cut = size
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest) out.push(rest)
  return out
}

/** A send that may already have reached the recipient (timeout, partial multi-bubble send). Retrying would duplicate it. */
export class DeliveryUncertain extends Error {
  readonly noRetry = true
}

/** Retries a send with backoff so a brief network or gateway reconnect doesn't drop a reply. */
export async function withRetry<T>(fn: () => Promise<T>, delays = [2000, 10_000, 30_000, 60_000]): Promise<T> {
  let last: unknown
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await fn()
    } catch (err) {
      last = err
      if ((err as { noRetry?: boolean })?.noRetry) throw err
      if (i < delays.length) await new Promise((r) => setTimeout(r, delays[i]))
    }
  }
  throw last
}

/** Applies `fn` to prose only, leaving fenced code blocks as written. */
function outsideCode(text: string, fn: (prose: string) => string): string {
  return text.split(/(```[\s\S]*?```)/g).map((part, i) => (i % 2 ? part : fn(part))).join('')
}

/** Agent Markdown as a text message: iMessage shows `**`, `#` and `[x](y)` literally. */
export function plainText(md: string): string {
  return outsideCode(md, (t) => t
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!?\[([^\]\n]+)\]\((\S+?)\)/g, (_, label: string, url: string) => (label === url ? url : `${label} (${url})`))
    .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, '$1')
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, '$1$2')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{0,}:?\s*$\n?/gm, '')
  ).replace(/```[^\n]*\n?([\s\S]*?)\n?```/g, '$1')
}

/** Agent Markdown as Slack mrkdwn: Slack has its own bold/link syntax and needs &, < and > escaped. */
export function slackText(md: string): string {
  return outsideCode(md, (t) => t
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^&gt;\s?/gm, '> ')
    .replace(/!?\[([^\]\n]+)\]\((\S+?)\)/g, (_, label: string, url: string) => `<${url}|${label}>`)
    .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, '*$1$2*')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
  )
}

/** Slack's wire format back to what the user typed: links unwrapped, entities decoded. */
export function slackIncoming(text: string): string {
  return text
    .replace(/<((?:https?|mailto|tel):[^>|]+)(?:\|([^>]+))?>/g, (_, target: string) => target.replace(/^(mailto|tel):/, ''))
    .replace(/<#C\w+\|([^>]*)>/g, '#$1')
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}
