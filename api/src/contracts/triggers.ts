import {
  AgentTriggerStatusSchema,
  AgentTriggerTypeSchema,
  ChannelIdSchema,
  RunIdSchema,
  ThreadIdSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema, TimestampSchema } from './shared.js'

// Trigger records are produced by `@nessie/workspace-admin`, which the worker
// also uses (the assistant's `agent_trigger_create` tool parses the very same
// create body), so these live in `@nessie/schemas`.
export {
  AgentTriggerActivityRecordSchema,
  AgentTriggerRecordSchema,
  AgentTriggerStatusSchema,
  CreateAgentTriggerBodySchema,
  type AgentTriggerActivityRecord,
  type AgentTriggerRecord,
  type AgentTriggerStatus,
  type AgentTriggerType,
} from '@nessie/schemas'

export const AgentTriggerDeliveryStatusSchema = z.enum([
  'pending',
  'delivered',
  'failed',
  'skipped',
  // W26: the fire was recorded but the installation's overlap policy was at
  // capacity, so no run was started.
  'skipped_overlap',
])
export type AgentTriggerDeliveryStatus = z.infer<typeof AgentTriggerDeliveryStatusSchema>

export const CreateWorkflowTriggerBodySchema = z.object({
  type: AgentTriggerTypeSchema,
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  nextRunAt: TimestampSchema.optional(),
})

export const UpdateAgentTriggerBodySchema = z.object({
  name: z.string().min(1).nullable().optional(),
  description: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  status: AgentTriggerStatusSchema.optional(),
  config: z.record(z.unknown()).optional(),
  nextRunAt: TimestampSchema.nullable().optional(),
  targetChannelId: ChannelIdSchema.nullable().optional(),
  targetThreadId: ThreadIdSchema.nullable().optional(),
})

export const AgentTriggerDeliveryRecordSchema = z.object({
  id: z.string().uuid(),
  triggerId: z.string().uuid(),
  dedupeKey: z.string().optional(),
  status: AgentTriggerDeliveryStatusSchema,
  source: z.string().optional(),
  payload: z.unknown(),
  errorMessage: z.string().optional(),
  runId: RunIdSchema.optional(),
  // The run's own outcome, which is a different question from whether the
  // delivery reached a worker. A fire that dispatched fine and then failed
  // during execution reads `status: 'delivered'` — without this the Triggers
  // page cannot tell anyone their schedule is broken.
  runStatus: z.string().optional(),
  deliveredAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
})
export type AgentTriggerDeliveryRecord = z.infer<typeof AgentTriggerDeliveryRecordSchema>

// `source` is deliberately absent: it is provenance, rendered as the delivery's
// origin on the Triggers page, and the route decides it. Accepting it from the
// body let a caller label their own fire `scheduler`, falsifying the one audit
// trail an operator has when a schedule misbehaves.
export const FireAgentTriggerBodySchema = z.object({
  dedupeKey: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  payload: z.unknown().optional(),
})

// `takeOver` is the owner's explicit "run this as me instead" — never implicit,
// because re-pointing a schedule's workspace moves its billing attribution.
export const ReauthorizeAgentTriggerBodySchema = z.object({
  takeOver: z.boolean().optional(),
})

// `source` is absent here for the same reason it is absent from the fire body:
// it is provenance shown in the delivery log, so a caller must not be able to
// label their own event `scheduler`.
export const PublishEventBodySchema = z.object({
  dedupeKey: z.string().min(1).optional(),
  eventType: NonEmptyStringSchema,
  payload: z.record(z.unknown()).default({}),
})
