import type { Effort, McpServerEntry, ProviderId, RunUsage } from '@shared/types'
import type { SteeringChannel } from './steering'

export type ToolGate = (tool: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<{ allow: true } | { allow: false; message: string }>

export interface ProviderStartOptions {
  runId: string
  prompt: string
  cwd: string
  model?: string
  resume?: string | null
  context: string
  mcpServers: Record<string, McpServerEntry>
  env: Record<string, string>
  gate: ToolGate
  effort?: Effort
  fork?: boolean
  signal: AbortSignal
  steering: SteeringChannel
  /** Maintenance runs use validated harness operations only. */
  harnessOnly?: boolean
  outputSchema?: Record<string, unknown>
}

export type ProviderEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'system'; data: Record<string, unknown> }
  | { type: 'delta'; text: string }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | { type: 'usage'; usage: RunUsage }
  | { type: 'result'; text: string; isError: boolean; error?: string }

export interface Provider {
  id: ProviderId
  run(opts: ProviderStartOptions): AsyncGenerator<ProviderEvent>
}

export class BillingViolation extends Error {}

/**
 * The full system prompt for either CLI. It replaces Claude Code's preset and Codex's base instructions, so it
 * carries the few runtime basics those supplied. It holds nothing that changes over time: a resumed session
 * keeps hitting the prompt cache across midnight. The current time travels with each message (`timeNote`).
 */
export function systemPrompt(context: string, cwd: string, timezone: string): string {
  return [
    context,
    [
      '## Operating basics',
      '- Act with tools and verify real results before reporting; never claim an outcome you did not observe.',
      '- Read and edit files with the file tools rather than shell cat/sed; run independent tool calls in parallel.',
      '- Confirm destructive, irreversible or outward-facing actions unless the user already authorized them.',
      '- Voice: talk like a sharp, relaxed person. Lead with the answer in plain words; no preamble, filler, recaps of the question, hedging or sign-offs. Short by default; go long only when asked or when the task truly needs it.',
      '- Your final message is shown to the user as Markdown (or sent as a text on iMessage/Slack).',
      `- Working directory: ${cwd}. macOS. Time zone: ${timezone}; a new message ends with the time it was sent.`
    ].join('\n')
  ].join('\n\n')
}

/** Appended to each new turn's message so the date never has to live in the cached system prompt. */
export function timeNote(timezone: string, now = new Date()): string {
  const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...o }).format(now)
  const date = now.toLocaleDateString('en-CA', { timeZone: timezone })
  return `\n\n(Sent ${part({ weekday: 'short' })} ${date} ${part({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} ${part({ timeZoneName: 'shortOffset' }).split(' ').pop()})`
}

export function stringifyOutput(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : c && typeof c === 'object' && 'type' in c ? `[${(c as { type: string }).type}]` : JSON.stringify(c)))
      .join('\n')
  }
  return JSON.stringify(content)
}
