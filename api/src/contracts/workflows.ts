import { AgentIdSchema, ChannelIdSchema, OrganizationIdSchema, RunIdSchema } from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema, TimestampSchema } from './shared.js'

export const WorkflowInstallationStatusSchema = z.enum([
  'draft',
  'active',
  'paused',
  'disabled',
])
export type WorkflowInstallationStatus = z.infer<typeof WorkflowInstallationStatusSchema>

export const WorkflowRunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>

export const WorkflowStepRunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'blocked',
])
export type WorkflowStepRunStatus = z.infer<typeof WorkflowStepRunStatusSchema>

export const WorkflowStepDefinitionSchema = z.object({
  id: NonEmptyStringSchema,
  input: z.record(z.unknown()).optional(),
  title: z.string().optional(),
  type: NonEmptyStringSchema,
  // W16: step-level predicate. Falsy marks the step `skipped`; the run
  // continues. Compiled at save time, evaluated off the event loop at run time.
  when: z.string().optional(),
})
export type WorkflowStepDefinition = z.infer<typeof WorkflowStepDefinitionSchema>

export const WorkflowGraphSchema = z.object({
  steps: z.array(WorkflowStepDefinitionSchema).min(1),
})
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>

export const WorkflowTemplateRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  name: NonEmptyStringSchema,
  description: z.string().nullish(),
  version: z.number().int().positive(),
  graph: WorkflowGraphSchema,
  triggers: z.unknown(),
  variableSchema: z.unknown(),
  bindingSchema: z.unknown(),
  requiredEnvironmentTemplateIds: z.array(z.string().uuid()),
  createdByActorType: NonEmptyStringSchema,
  createdByActorId: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type WorkflowTemplateRecord = z.infer<typeof WorkflowTemplateRecordSchema>

// §5 stepSamples: provenance + redacted per-step output from the last
// successful designer test run. Served only behind the owner-gated samples
// route; never embedded in the generic template record.
export const WorkflowStepSamplesRecordSchema = z.object({
  templateVersion: z.number().int().positive(),
  workflowInstallationId: z.string().uuid(),
  workflowRunId: z.string().uuid(),
  capturedAt: TimestampSchema,
  steps: z.record(z.unknown()),
})
export type WorkflowStepSamplesRecord = z.infer<typeof WorkflowStepSamplesRecordSchema>

export const RecordWorkflowStepSamplesBodySchema = z.object({
  workflowInstallationId: z.string().uuid(),
  workflowRunId: z.string().uuid(),
  stepOutputs: z.record(z.unknown()),
})

export const RecordWorkflowStepSamplesResultSchema = z.object({
  result: z.enum(['recorded', 'quota_exceeded']),
})

export const CreateWorkflowTemplateBodySchema = z.object({
  name: NonEmptyStringSchema,
  description: z.string().optional(),
  graph: WorkflowGraphSchema,
  triggers: z.unknown().optional(),
  variableSchema: z.unknown().optional(),
  bindingSchema: z.unknown().optional(),
  requiredEnvironmentTemplateIds: z.array(z.string().uuid()).optional(),
})

export const UpdateWorkflowTemplateBodySchema = CreateWorkflowTemplateBodySchema

// W26: { limit, onOverlap } — parseWorkflowConcurrency in workspace-admin
// supplies the defaults at enforcement time, so an empty object is valid.
export const WorkflowConcurrencySchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    onOverlap: z.enum(['skip', 'queue', 'parallel']).optional(),
  })
  .default({})

export const WorkflowInstallationRecordSchema = z.object({
  id: z.string().uuid(),
  workflowTemplateId: z.string().uuid(),
  workflowTemplateVersion: z.number().int().positive(),
  organizationId: OrganizationIdSchema,
  projectId: z.string().uuid().nullish(),
  teamId: z.string().uuid().nullish(),
  channelId: ChannelIdSchema.nullish(),
  status: WorkflowInstallationStatusSchema,
  active: z.boolean(),
  resolvedBindings: z.record(z.unknown()).default({}),
  config: z.record(z.unknown()).default({}),
  // W26: overlap policy, defaulting to { limit: 1, onOverlap: 'skip' }.
  concurrency: WorkflowConcurrencySchema,
  createdByActorType: NonEmptyStringSchema,
  createdByActorId: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type WorkflowInstallationRecord = z.infer<typeof WorkflowInstallationRecordSchema>

export const InstallWorkflowTemplateBodySchema = z.object({
  channelId: ChannelIdSchema.optional(),
  active: z.boolean().optional(),
  status: WorkflowInstallationStatusSchema.optional(),
  resolvedBindings: z.record(z.unknown()).optional(),
  config: z.record(z.unknown()).optional(),
  concurrency: WorkflowConcurrencySchema.optional(),
})

// W8: the pause/resume/disable path. Same lifecycle fields as install;
// contradictory active/status combinations are rejected by the service.
export const UpdateWorkflowInstallationBodySchema = z.object({
  channelId: ChannelIdSchema.optional(),
  active: z.boolean().optional(),
  status: WorkflowInstallationStatusSchema.optional(),
  resolvedBindings: z.record(z.unknown()).optional(),
  config: z.record(z.unknown()).optional(),
  concurrency: WorkflowConcurrencySchema.optional(),
})

// W24: cursor pagination for the workflow list endpoints.
export const WorkflowListQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().optional(),
})

export const WorkflowRunRecordSchema = z.object({
  id: z.string().uuid(),
  installationId: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  triggerId: z.string().uuid().nullish(),
  triggerDeliveryId: z.string().uuid().nullish(),
  parentRunId: RunIdSchema.nullish(),
  retriedFromWorkflowRunId: z.string().uuid().nullish(),
  planId: z.string().uuid().nullish(),
  planStepId: z.string().uuid().nullish(),
  status: WorkflowRunStatusSchema,
  input: z.unknown(),
  output: z.unknown(),
  summary: z.string().nullish(),
  errorMessage: z.string().nullish(),
  startedByActorType: NonEmptyStringSchema,
  startedByActorId: NonEmptyStringSchema,
  startedAt: TimestampSchema.nullish(),
  finishedAt: TimestampSchema.nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type WorkflowRunRecord = z.infer<typeof WorkflowRunRecordSchema>

export const WorkflowStepRunRecordSchema = z.object({
  id: z.string().uuid(),
  workflowRunId: z.string().uuid(),
  stepKey: NonEmptyStringSchema,
  stepType: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  sequence: z.number().int().nonnegative(),
  status: WorkflowStepRunStatusSchema,
  input: z.unknown(),
  output: z.unknown(),
  errorMessage: z.string().nullish(),
  assignedAgentId: AgentIdSchema.nullish(),
  agentRunId: RunIdSchema.nullish(),
  taskId: z.string().uuid().nullish(),
  environmentInstanceId: z.string().uuid().nullish(),
  startedAt: TimestampSchema.nullish(),
  finishedAt: TimestampSchema.nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type WorkflowStepRunRecord = z.infer<typeof WorkflowStepRunRecordSchema>

export const WorkflowStateEntryRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  workflowInstallationId: z.string().uuid(),
  workflowRunId: z.string().uuid().nullish(),
  workflowStepRunId: z.string().uuid().nullish(),
  key: NonEmptyStringSchema,
  value: z.unknown(),
  valueHash: NonEmptyStringSchema,
  version: z.number().int().positive(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type WorkflowStateEntryRecord = z.infer<typeof WorkflowStateEntryRecordSchema>

export const CreateWorkflowRunBodySchema = z.object({
  input: z.record(z.unknown()).optional(),
  triggerId: z.string().uuid().optional(),
  triggerDeliveryId: z.string().uuid().optional(),
  parentRunId: RunIdSchema.optional(),
  planId: z.string().uuid().optional(),
  planStepId: z.string().uuid().optional(),
})

export const CancelWorkflowRunBodySchema = z.object({
  reason: z.string().min(1).optional(),
})

export const RetryWorkflowRunBodySchema = z.object({
  reason: z.string().min(1).optional(),
})

export const SkipWorkflowStepRunBodySchema = z.object({
  reason: z.string().min(1).optional(),
})

export const BlockWorkflowStepRunBodySchema = z.object({
  reason: z.string().min(1).optional(),
})

export const UnblockWorkflowStepRunBodySchema = z.object({
  reason: z.string().min(1).optional(),
})
