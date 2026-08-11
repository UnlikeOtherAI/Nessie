import {
  AgentIdSchema,
  AgentTriggerTypeSchema,
  ChannelIdSchema,
  RunIdSchema,
  ThreadIdSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema, TimestampSchema } from './shared.js'

export type AgentTriggerType = z.infer<typeof AgentTriggerTypeSchema>

export const AgentTriggerStatusSchema = z.enum(['active', 'paused', 'error'])
export type AgentTriggerStatus = z.infer<typeof AgentTriggerStatusSchema>

export const AgentTriggerDeliveryStatusSchema = z.enum([
  'pending',
  'delivered',
  'failed',
  'skipped',
])
export type AgentTriggerDeliveryStatus = z.infer<typeof AgentTriggerDeliveryStatusSchema>

export const AgentTriggerRecordSchema = z.object({
  id: z.string().uuid(),
  agentId: AgentIdSchema.optional(),
  workflowInstallationId: z.string().uuid().optional(),
  type: AgentTriggerTypeSchema,
  status: AgentTriggerStatusSchema,
  enabled: z.boolean(),
  name: z.string().optional(),
  description: z.string().optional(),
  config: z.record(z.unknown()),
  webhookApiKey: z.string().optional(),
  targetChannelId: ChannelIdSchema.optional(),
  targetThreadId: ThreadIdSchema.optional(),
  lastFiredAt: TimestampSchema.optional(),
  nextRunAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type AgentTriggerRecord = z.infer<typeof AgentTriggerRecordSchema>

export const CreateAgentTriggerBodySchema = z.object({
  type: AgentTriggerTypeSchema,
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  nextRunAt: TimestampSchema.optional(),
  targetChannelId: ChannelIdSchema.optional(),
  targetThreadId: ThreadIdSchema.optional(),
})

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

export const FireAgentTriggerBodySchema = z.object({
  dedupeKey: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  payload: z.unknown().optional(),
})

export const PublishEventBodySchema = z.object({
  dedupeKey: z.string().min(1).optional(),
  eventType: NonEmptyStringSchema,
  payload: z.record(z.unknown()).default({}),
  source: z.string().min(1).optional(),
})
