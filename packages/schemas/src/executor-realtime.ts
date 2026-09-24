import { z } from 'zod'
import { ExecutorIdSchema, ExecutorStatusSchema } from './executor.js'
import { TimestampSchema } from './schema-primitives.js'

/** Live presence only. Machine policy, programs and paths never travel here. */
export const ExecutorStatusChangedSchema = z.object({
  executorId: ExecutorIdSchema,
  status: ExecutorStatusSchema,
  lastSeenAt: TimestampSchema.nullable(),
  statusDetail: z.string().nullable(),
  updatedAt: TimestampSchema,
  removed: z.boolean(),
})
export type ExecutorStatusChanged = z.infer<typeof ExecutorStatusChangedSchema>
