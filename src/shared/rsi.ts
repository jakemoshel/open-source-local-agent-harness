import { z } from 'zod'
import { SMALL_MODEL, LARGE_MODEL } from './rsi-defaults'
export { SMALL_MODEL, LARGE_MODEL } from './rsi-defaults'

export const rsiModelSchema = z.object({
  provider: z.enum(['claude', 'codex']), model: z.string().min(1),
  effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).default('medium')
})
export const rsiSettingsSchema = z.object({
  enabled: z.boolean().default(true), maxPerDay: z.number().int().min(0).default(10),
  proactive: z.boolean().default(true), intervalHours: z.number().positive().default(1),
  small: rsiModelSchema.default(SMALL_MODEL), large: rsiModelSchema.default(LARGE_MODEL),
  smallMaxFiles: z.number().int().positive().default(3), smallMaxMinutes: z.number().positive().default(30),
  escalate: z.boolean().default(true), sliceMinutes: z.number().positive().default(30),
  retryMinutes: z.number().positive().default(10), maxAttempts: z.number().int().min(0).default(0),
  instructions: z.string().default('')
})
export const assessmentSchema = z.object({
  size: z.enum(['small', 'large']), reason: z.string().min(1),
  files: z.array(z.string()), components: z.array(z.string()), estimatedMinutes: z.number().min(0),
  validation: z.enum(['regression', 'checks', 'benchmark', 'browser']),
  priority: z.number().min(0).max(100)
})
export type RsiSettings = z.infer<typeof rsiSettingsSchema>
export type RsiModel = z.infer<typeof rsiModelSchema>
export type RsiAssessment = z.infer<typeof assessmentSchema>
export const RSI_DEFAULTS = rsiSettingsSchema.parse({})

/** The triggering review supplies scope; this final routing step applies the owner's thresholds. */
export function routeAssessment(assessment: RsiAssessment, settings: RsiSettings): RsiAssessment {
  const files = [...new Set(assessment.files)], components = [...new Set(assessment.components)]
  const large = assessment.size === 'large' || files.length > settings.smallMaxFiles || components.length > 1 || assessment.estimatedMinutes > settings.smallMaxMinutes
  return { ...assessment, files, components, size: large ? 'large' : 'small', reason: large && assessment.size === 'small' ? `${assessment.reason}; scope exceeds the configured small-task thresholds` : assessment.reason }
}

export const proposalSchema = z.object({
  none: z.boolean(), title: z.string().max(200), evidence: z.string().max(2000), expected: z.string().max(2000), assessment: assessmentSchema
}).refine(p => p.none || !!(p.title.trim() && p.evidence.trim() && p.expected.trim()), 'A proposal needs a title, evidence and expected behavior')
export type Proposal = z.infer<typeof proposalSchema>
export const repairResultSchema = z.object({
  outcome: z.enum(['complete', 'continue', 'escalate', 'not_a_bug']), summary: z.string(),
  diagnosis: z.string(), progress: z.string(), nextAction: z.string(), assessment: assessmentSchema,
  validation: z.object({ command: z.array(z.string()), evidence: z.string() })
})
export type RepairResult = z.infer<typeof repairResultSchema>
export const assessmentInstructions = `Classify implementation scope before queuing work. Small: a local defect, one-off breakage, dead code, or a routine skill/harness improvement with a known approach. Large: a cross-component feature, architectural change, migration, or complex investigation. Report size, reason, concrete files, components, estimatedMinutes, validation (regression/checks/benchmark/browser), and priority (0-100, user impact plus recurrence). Frequency and severity affect priority, not implementation size. Choose checks for behavior-preserving cleanup, regression for defects, benchmark for performance, and browser for visual workflows.`
