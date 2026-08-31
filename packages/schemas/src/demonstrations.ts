import { z } from 'zod'

import {
  AgentIdSchema,
  ChannelIdSchema,
  OrganizationIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  UserIdSchema,
} from './ids.js'
import { TimestampSchema } from './schema-primitives.js'

export const DemonstrationStatusSchema = z.enum([
  'recording',
  'captured',
  'generalized',
  'discarded',
])
export type DemonstrationStatus = z.infer<typeof DemonstrationStatusSchema>

export const DemonstrationRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  agentId: AgentIdSchema,
  channelId: ChannelIdSchema,
  threadId: ThreadIdSchema,
  startedByUserId: UserIdSchema,
  status: DemonstrationStatusSchema,
  stepCount: z.number().int().nonnegative(),
  startedAt: TimestampSchema,
  capturedAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema,
})
export type DemonstrationRecord = z.infer<typeof DemonstrationRecordSchema>

export const DemonstrationStepRecordSchema = z.object({
  id: z.string().uuid(),
  demonstrationId: z.string().uuid(),
  runId: RunIdSchema.nullable(),
  agentId: AgentIdSchema,
  sequence: z.number().int().positive(),
  toolName: z.string().min(1),
  argumentsJson: z.unknown(),
  success: z.boolean(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema,
  durationMs: z.number().int().nonnegative(),
})
export type DemonstrationStepRecord = z.infer<typeof DemonstrationStepRecordSchema>

export const DemonstrationDetailRecordSchema = DemonstrationRecordSchema.extend({
  steps: z.array(DemonstrationStepRecordSchema),
})
export type DemonstrationDetailRecord = z.infer<typeof DemonstrationDetailRecordSchema>
