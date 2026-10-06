import type { Run, RunEvent } from '@shared/types'

export const REVIEW_OPS = new Set(['skills_list', 'skills_search', 'skills_get', 'skills_save', 'skills_patch', 'skills_stats', 'skills_evaluate', 'skills_read_reference', 'skills_write_reference', 'memory_list', 'memory_read', 'memory_search', 'memory_edit', 'runs_list', 'session_search', 'faults_list', 'harness_report_defect', 'improvement_list', 'improvement_read', 'improvement_note', 'rsi_statistics'])
export const MEMORY_OPS = new Set(['context_list', 'context_search', 'context_read', 'context_upsert', 'context_snapshot', 'context_commit', 'context_history', 'context_forget', 'transcripts_since', 'memory_list', 'memory_read', 'memory_search'])
export function memoryToolAllowed(tool: string, input: Record<string, unknown>): boolean {
  if (tool.endsWith('harness_ops')) return !input.op || MEMORY_OPS.has(String(input.op))
  return tool.endsWith('harness_call') && MEMORY_OPS.has(String(input.op))
}

export function reviewToolAllowed(tool: string, input: Record<string, unknown>): boolean {
  if (tool.endsWith('harness_ops')) return !input.op || REVIEW_OPS.has(String(input.op))
  return tool.endsWith('harness_call') && REVIEW_OPS.has(String(input.op))
}

interface LearningSignalDetails {
  signal: string
  urgency: 'high' | 'normal'
  category: 'user_correction' | 'tool_failure_recovery' | 'skill_defect' | 'substantial_procedure'
}

const CORRECTION = /\b(instead|wrong|incorrect|stop doing|don't do|do not do|next time|remember to|i told you|i meant)\b/i

/**
 * User messages that correct or instruct the agent. A run's opening prompt is the task itself ("use X instead of Y",
 * "find what's wrong"), so it only counts when it follows an earlier turn of the same conversation.
 */
export function correctionCount(users: { text?: unknown; steering?: unknown }[], followUp: boolean): number {
  return users.filter(u => (followUp || u.steering) && CORRECTION.test(String(u.text ?? ''))).length
}

/** Tool count alone is not a lesson. Review corrections, recovered errors and substantial uncovered work. */
export function learningSignal(run: Run, events: RunEvent[], minToolCalls: number, loaded: boolean, saved: boolean, followUp = false): string | null {
  if (saved) return null
  if (correctionCount(events.filter(e => e.type === 'user').map(e => e.data), followUp)) return 'user correction or explicit instruction'
  const calls = events.filter(e => e.type === 'tool_call').length
  const errors = events.filter(e => e.type === 'tool_result' && e.data.isError).length
  if (errors) return loaded ? 'used skill needs review' : run.status === 'succeeded' ? 'recovered tool failure' : 'tool failure needs review'
  if (calls < minToolCalls) return null
  if (loaded && run.status === 'failed') return 'used skill needs review'
  if (!loaded && run.status === 'succeeded' && calls >= Math.max(12, minToolCalls * 2)) return 'substantial task without a saved procedure'
  return null
}

/** Hermes-style priority classification: user corrections and broken skills trigger expedited reflection. */
export function learningSignalWithUrgency(run: Run, events: RunEvent[], minToolCalls: number, loaded: boolean, saved: boolean, followUp = false): LearningSignalDetails | null {
  const signal = learningSignal(run, events, minToolCalls, loaded, saved, followUp)
  if (!signal) return null
  // A recovered tool error is routine in most substantial tasks; it waits for the normal batch instead of an immediate review.
  const isHigh = signal === 'user correction or explicit instruction' || signal === 'used skill needs review' || signal === 'tool failure needs review'
  const category: LearningSignalDetails['category'] =
    signal === 'user correction or explicit instruction' ? 'user_correction' :
    signal === 'used skill needs review' ? 'skill_defect' :
    ['recovered tool failure', 'tool failure needs review'].includes(signal) ? 'tool_failure_recovery' :
    'substantial_procedure'
  return { signal, urgency: isHigh ? 'high' : 'normal', category }
}

/** Bounded evidence, including successful tool outputs and later user corrections. No full-session replay. */
export function learningDigest(run: Run, events: RunEvent[]): string {
  const evidence = events.filter(e => ['user', 'tool_call', 'tool_result'].includes(e.type)).slice(-30).map(e => {
    const value = e.type === 'user' ? e.data.text : e.type === 'tool_call' ? { name: e.data.name, input: e.data.input } : { error: e.data.isError, output: e.data.output }
    return `${e.type}: ${JSON.stringify(value)?.slice(0, 700) ?? ''}`
  })
  return `Task: ${run.prompt.slice(0, 1200)}\nOutcome: ${run.status}\n${evidence.join('\n').slice(-5500)}\nFinal: ${(run.result ?? run.error ?? '').slice(0, 2000)}`.slice(0, 9000)
}
