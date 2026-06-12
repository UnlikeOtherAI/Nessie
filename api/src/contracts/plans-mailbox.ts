import {
  AgentIdSchema,
  ChannelIdSchema,
  OrganizationIdSchema,
  RunIdSchema,
  ThreadIdSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema, TimestampSchema } from './shared.js'

export const PlanStatusSchema = z.enum([
  'draft',
  'active',
  'waiting',
  'completed',
  'failed',
  'cancelled',
])
export type PlanStatus = z.infer<typeof PlanStatusSchema>

export const PlanStepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'blocked',
])
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>

export const PlanRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  projectId: z.string().uuid().nullish(),
  teamId: z.string().uuid().nullish(),
  channelId: ChannelIdSchema.nullish(),
  runId: RunIdSchema.nullish(),
  agentId: AgentIdSchema.nullish(),
  goal: NonEmptyStringSchema,
  summary: z.string().nullish(),
  status: PlanStatusSchema,
  createdByActorType: NonEmptyStringSchema,
  createdByActorId: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type PlanRecord = z.infer<typeof PlanRecordSchema>

export const PlanStepRecordSchema = z.object({
  id: z.string().uuid(),
  planId: z.string().uuid(),
  assignedAgentId: AgentIdSchema.nullish(),
  type: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  sequence: z.number().int().nonnegative(),
  status: PlanStepStatusSchema,
  payload: z.record(z.unknown()).default({}),
  artifacts: z.record(z.unknown()).default({}),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type PlanStepRecord = z.infer<typeof PlanStepRecordSchema>

export const CreatePlanBodySchema = z.object({
  agentId: AgentIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  goal: NonEmptyStringSchema,
  runId: RunIdSchema.optional(),
  summary: z.string().optional(),
})

export const CreatePlanStepBodySchema = z.object({
  assignedAgentId: AgentIdSchema.optional(),
  artifacts: z.record(z.unknown()).optional(),
  payload: z.record(z.unknown()).optional(),
  sequence: z.number().int().nonnegative().optional(),
  title: NonEmptyStringSchema,
  type: NonEmptyStringSchema,
})

export const MailboxMessageStatusSchema = z.enum([
  'queued',
  'processing',
  'delivered',
  'dead_letter',
])
export type MailboxMessageStatus = z.infer<typeof MailboxMessageStatusSchema>

export const MailboxMessageRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  planId: z.string().uuid().nullish(),
  planStepId: z.string().uuid().nullish(),
  workflowRunId: z.string().uuid().nullish(),
  workflowStepRunId: z.string().uuid().nullish(),
  fromAgentId: AgentIdSchema.nullish(),
  toAgentId: AgentIdSchema.nullish(),
  channelId: ChannelIdSchema.nullish(),
  threadId: ThreadIdSchema.nullish(),
  subject: z.string().nullish(),
  body: z.string(),
  correlationId: z.string().nullish(),
  status: MailboxMessageStatusSchema,
  attempts: z.number().int().nonnegative(),
  visibleAt: TimestampSchema,
  claimedAt: TimestampSchema.nullish(),
  deliveredAt: TimestampSchema.nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type MailboxMessageRecord = z.infer<typeof MailboxMessageRecordSchema>

export const CreateMailboxMessageBodySchema = z.object({
  body: NonEmptyStringSchema,
  channelId: ChannelIdSchema.optional(),
  correlationId: NonEmptyStringSchema.optional(),
  fromAgentId: AgentIdSchema.optional(),
  planId: z.string().uuid().optional(),
  planStepId: z.string().uuid().optional(),
  workflowRunId: z.string().uuid().optional(),
  workflowStepRunId: z.string().uuid().optional(),
  subject: z.string().optional(),
  threadId: ThreadIdSchema.optional(),
  toAgentId: AgentIdSchema.optional(),
})
