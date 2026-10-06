import { z } from 'zod'
import { cfg } from './config'
import { assessmentSchema, assessmentInstructions, rsiSettingsSchema, routeAssessment, type RsiAssessment } from '@shared/rsi'

export { assessmentInstructions }
export const rsiSettings = () => rsiSettingsSchema.parse(cfg().selfRepair ?? {})
export const rsiModel = (size: 'small' | 'large') => rsiSettings()[size]
export const assessScope = (value: unknown): RsiAssessment => routeAssessment(assessmentSchema.parse(value), rsiSettings())
export const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema) as Record<string, unknown>
export const defaultAssessment = (reason = 'Local repair; scope will be established by review'): RsiAssessment => ({
  size: 'small', reason, files: [], components: [], estimatedMinutes: 10, validation: 'regression', priority: 50
})
