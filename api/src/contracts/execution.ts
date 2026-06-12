import { AgentIdSchema, ChannelIdSchema, OrganizationIdSchema, RunIdSchema } from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema, TimestampSchema } from './shared.js'

export const ExecutionProviderSchema = z.enum(['docker', 'gcloud'])
export type ExecutionProvider = z.infer<typeof ExecutionProviderSchema>

export const ExecutionModeSchema = z.enum(['container', 'vm', 'function'])
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>

export const ExecutionEnvironmentInstanceStatusSchema = z.enum([
  'pending',
  'provisioning',
  'ready',
  'failed',
  'terminated',
])
export type ExecutionEnvironmentInstanceStatus = z.infer<typeof ExecutionEnvironmentInstanceStatusSchema>

export const ExecutionRunnerStatusSchema = z.enum(['active', 'draining', 'offline'])
export type ExecutionRunnerStatus = z.infer<typeof ExecutionRunnerStatusSchema>

export const ExecutionLeaseStatusSchema = z.enum([
  'issued',
  'acknowledged',
  'completed',
  'revoked',
  'expired',
])
export type ExecutionLeaseStatus = z.infer<typeof ExecutionLeaseStatusSchema>

export const ExecutionEnvironmentTemplateRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  projectId: z.string().uuid().nullish(),
  teamId: z.string().uuid().nullish(),
  channelId: ChannelIdSchema.nullish(),
  name: NonEmptyStringSchema,
  description: z.string().nullish(),
  provider: ExecutionProviderSchema,
  mode: ExecutionModeSchema,
  image: z.string().nullish(),
  launchConfig: z.record(z.unknown()).default({}),
  pricingConfig: z.record(z.unknown()).default({}),
  enabled: z.boolean(),
  createdByActorType: NonEmptyStringSchema,
  createdByActorId: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ExecutionEnvironmentTemplateRecord = z.infer<
  typeof ExecutionEnvironmentTemplateRecordSchema
>

export const CreateExecutionEnvironmentTemplateBodySchema = z.object({
  name: NonEmptyStringSchema,
  description: z.string().optional(),
  provider: ExecutionProviderSchema,
  mode: ExecutionModeSchema,
  image: z.string().optional(),
  launchConfig: z.record(z.unknown()).optional(),
  pricingConfig: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
  channelId: ChannelIdSchema.optional(),
})

export const ExecutionEnvironmentInstanceRecordSchema = z.object({
  id: z.string().uuid(),
  templateId: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  projectId: z.string().uuid().nullish(),
  teamId: z.string().uuid().nullish(),
  channelId: ChannelIdSchema.nullish(),
  workflowRunId: z.string().uuid().nullish(),
  workflowStepRunId: z.string().uuid().nullish(),
  runId: RunIdSchema.nullish(),
  agentId: AgentIdSchema.nullish(),
  status: ExecutionEnvironmentInstanceStatusSchema,
  launchedByActorType: NonEmptyStringSchema,
  launchedByActorId: NonEmptyStringSchema,
  providerInstanceRef: z.string().nullish(),
  launchConfig: z.record(z.unknown()).default({}),
  metadata: z.record(z.unknown()).default({}),
  errorMessage: z.string().nullish(),
  startedAt: TimestampSchema.nullish(),
  readyAt: TimestampSchema.nullish(),
  terminatedAt: TimestampSchema.nullish(),
  lastHeartbeatAt: TimestampSchema.nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ExecutionEnvironmentInstanceRecord = z.infer<
  typeof ExecutionEnvironmentInstanceRecordSchema
>

export const LaunchExecutionEnvironmentBodySchema = z.object({
  templateId: z.string().uuid(),
  workflowRunId: z.string().uuid().optional(),
  workflowStepRunId: z.string().uuid().optional(),
  runId: RunIdSchema.optional(),
  agentId: AgentIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  launchConfig: z.record(z.unknown()).optional(),
})

export const ExecutionRunnerRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema.nullish(),
  provider: ExecutionProviderSchema,
  label: NonEmptyStringSchema,
  capabilities: z.record(z.unknown()).default({}),
  status: ExecutionRunnerStatusSchema,
  heartbeatAt: TimestampSchema.nullish(),
  metadata: z.record(z.unknown()).default({}),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ExecutionRunnerRecord = z.infer<typeof ExecutionRunnerRecordSchema>

export const ExecutionLeaseRecordSchema = z.object({
  id: z.string().uuid(),
  instanceId: z.string().uuid(),
  runnerId: z.string().uuid(),
  status: ExecutionLeaseStatusSchema,
  leaseToken: NonEmptyStringSchema,
  expiresAt: TimestampSchema,
  acknowledgedAt: TimestampSchema.nullish(),
  completedAt: TimestampSchema.nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ExecutionLeaseRecord = z.infer<typeof ExecutionLeaseRecordSchema>

export const ExecutionUsageLedgerRecordSchema = z.object({
  id: z.string().uuid(),
  instanceId: z.string().uuid(),
  templateId: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  projectId: z.string().uuid().nullish(),
  teamId: z.string().uuid().nullish(),
  channelId: ChannelIdSchema.nullish(),
  workflowRunId: z.string().uuid().nullish(),
  workflowStepRunId: z.string().uuid().nullish(),
  runId: RunIdSchema.nullish(),
  agentId: AgentIdSchema.nullish(),
  actorType: NonEmptyStringSchema,
  actorId: NonEmptyStringSchema,
  meterType: NonEmptyStringSchema,
  quantity: z.number().nonnegative(),
  unitPrice: z.number().nonnegative().nullish(),
  costAmount: z.number().nonnegative().nullish(),
  currency: z.string().nullish(),
  metadata: z.record(z.unknown()).default({}),
  recordedAt: TimestampSchema,
})
export type ExecutionUsageLedgerRecord = z.infer<typeof ExecutionUsageLedgerRecordSchema>

export const ResourceLockTypeSchema = z.enum(['exclusive', 'shared'])
export type ResourceLockType = z.infer<typeof ResourceLockTypeSchema>

export const ResourceLockRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  planId: z.string().uuid().nullish(),
  runId: RunIdSchema.nullish(),
  agentId: AgentIdSchema,
  resourcePath: NonEmptyStringSchema,
  lockType: ResourceLockTypeSchema,
  acquiredAt: TimestampSchema,
  expiresAt: TimestampSchema,
  releasedAt: TimestampSchema.nullish(),
})
export type ResourceLockRecord = z.infer<typeof ResourceLockRecordSchema>

export const AcquireResourceLockBodySchema = z.object({
  agentId: AgentIdSchema,
  expiresAt: TimestampSchema.optional(),
  lockType: ResourceLockTypeSchema.optional(),
  planId: z.string().uuid().optional(),
  resourcePath: NonEmptyStringSchema,
  runId: RunIdSchema.optional(),
})
