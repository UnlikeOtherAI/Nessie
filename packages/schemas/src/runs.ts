import { z } from 'zod'
import { RunIdSchema, NonEmptyStringSchema, TimestampSchema } from './index.js'

export const ActiveRunRecordSchema = z.object({
  runId: RunIdSchema,
  agentId: NonEmptyStringSchema,
  threadId: NonEmptyStringSchema,
  status: z.enum(['pending', 'running', 'waiting_approval']),
  startedAt: TimestampSchema,
  tokenUsage: z.object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  }).optional(),
  steerQueueLength: z.number().int().nonnegative(),
})
export type ActiveRunRecord = z.infer<typeof ActiveRunRecordSchema>

export const SteerRunBodySchema = z.object({
  instruction: NonEmptyStringSchema,
})
export type SteerRunBody = z.infer<typeof SteerRunBodySchema>
