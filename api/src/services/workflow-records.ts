import { parseWorkflowConcurrency, redactWorkflowInstallationSecrets } from '@nessie/team-admin'
import {
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseRunId,
  type PaginationDirection,
  type PaginationMeta,
} from '@nessie/schemas'

import type {
  WorkflowGraph,
  WorkflowInstallationRecord,
  WorkflowRunRecord,
  WorkflowStepRunRecord,
  WorkflowTemplateRecord,
} from '../contracts/workflows.js'
import { WorkflowGraphSchema } from '../contracts/workflows.js'
import { parseOptional, toJsonRecord } from './contract-helpers.js'

// The row shapes the workflow services select, and the one place a row becomes
// an API record. The mappers are the W0 redaction boundary, so every service
// that answers with a workflow record goes through here rather than shaping a
// response of its own.

type WorkflowTemplateWithGraph = {
  adoptedAt?: Date | null
  bindingSchema: unknown
  createdAt: Date
  createdByActorId: string
  createdByActorType: string
  description: string | null
  demonstrationId?: string | null
  graphJson: unknown
  id: string
  name: string
  organizationId: string
  requiredEnvironmentTemplateIds: unknown
  source?: 'authored' | 'demonstration'
  triggersJson: unknown
  updatedAt: Date
  variableSchema: unknown
  version: number
}

type WorkflowInstallationRow = {
  active: boolean
  /** W0: per-binding literal/reference declaration from the owning template. */
  bindingSchema?: unknown
  channelId: string | null
  concurrency?: unknown
  config: unknown
  createdAt: Date
  createdByActorId: string
  createdByActorType: string
  id: string
  organizationId: string
  projectId: string | null
  resolvedBindings: unknown
  status: 'active' | 'disabled' | 'draft' | 'paused'
  teamId: string | null
  updatedAt: Date
  workflowTemplateId: string
  workflowTemplateVersion: number
}

export type WorkflowRunRow = {
  createdAt: Date
  errorMessage: string | null
  finishedAt: Date | null
  id: string
  input: unknown
  installationId: string
  organizationId: string
  originChannelId: string | null
  originMessageId: string | null
  originThreadId: string | null
  output: unknown
  parentRunId: string | null
  replyRootMessageId: string | null
  retriedFromWorkflowRunId: string | null
  planId: string | null
  planStepId: string | null
  startedAt: Date | null
  startedByActorId: string
  startedByActorType: string
  status: 'cancelled' | 'completed' | 'failed' | 'pending' | 'running'
  summary: string | null
  triggerDeliveryId: string | null
  triggerId: string | null
  updatedAt: Date
}

type WorkflowStepRunRow = {
  agentRunId: string | null
  assignedAgentId: string | null
  createdAt: Date
  environmentInstance: { id: string } | null
  errorMessage: string | null
  finishedAt: Date | null
  id: string
  input: unknown
  output: unknown
  sequence: number
  startedAt: Date | null
  status: 'blocked' | 'completed' | 'failed' | 'pending' | 'running' | 'skipped'
  stepKey: string
  stepType: string
  taskId: string | null
  title: string
  updatedAt: Date
  workflowRunId: string
}

const parseWorkflowGraph = (value: unknown): WorkflowGraph =>
  WorkflowGraphSchema.parse(value && typeof value === 'object' && !Array.isArray(value) ? value : {})

const parseUuidArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []

export type WorkflowInstallationSummary = {
  active: number
  total: number
}

export const mapWorkflowTemplate = (
  template: WorkflowTemplateWithGraph,
  installationSummary?: WorkflowInstallationSummary,
): WorkflowTemplateRecord => ({
  ...(installationSummary ? { installationSummary } : {}),
  id: template.id,
  organizationId: parseOrganizationId(template.organizationId),
  name: template.name,
  description: template.description ?? undefined,
  version: template.version,
  graph: parseWorkflowGraph(template.graphJson),
  triggers: template.triggersJson,
  variableSchema: template.variableSchema,
  bindingSchema: template.bindingSchema,
  requiredEnvironmentTemplateIds: parseUuidArray(template.requiredEnvironmentTemplateIds),
  source: template.source ?? 'authored',
  demonstrationId: template.demonstrationId ?? undefined,
  adoptedAt: template.adoptedAt?.toISOString(),
  createdByActorType: template.createdByActorType,
  createdByActorId: template.createdByActorId,
  createdAt: template.createdAt.toISOString(),
  updatedAt: template.updatedAt.toISOString(),
})

export const mapWorkflowInstallation = (
  installation: WorkflowInstallationRow,
): WorkflowInstallationRecord => ({
  id: installation.id,
  workflowTemplateId: installation.workflowTemplateId,
  workflowTemplateVersion: installation.workflowTemplateVersion,
  organizationId: parseOrganizationId(installation.organizationId),
  projectId: installation.projectId ?? undefined,
  teamId: installation.teamId ?? undefined,
  channelId: parseOptional(installation.channelId, parseChannelId),
  status: installation.status,
  active: installation.active,
  // W0 sink 1: redaction happens server-side in the response mapper, never
  // in the admin. Reference bindings render as the redaction marker.
  resolvedBindings: toJsonRecord(
    redactWorkflowInstallationSecrets(installation.resolvedBindings, installation.bindingSchema),
  ),
  config: toJsonRecord(
    redactWorkflowInstallationSecrets(installation.config, installation.bindingSchema),
  ),
  concurrency: parseWorkflowConcurrency(installation.concurrency),
  createdByActorType: installation.createdByActorType,
  createdByActorId: installation.createdByActorId,
  createdAt: installation.createdAt.toISOString(),
  updatedAt: installation.updatedAt.toISOString(),
})

export const mapWorkflowRun = (run: WorkflowRunRow): WorkflowRunRecord => ({
  id: run.id,
  installationId: run.installationId,
  organizationId: parseOrganizationId(run.organizationId),
  triggerId: run.triggerId ?? undefined,
  triggerDeliveryId: run.triggerDeliveryId ?? undefined,
  originChannelId: run.originChannelId ?? undefined,
  originMessageId: run.originMessageId ?? undefined,
  originThreadId: run.originThreadId ?? undefined,
  replyRootMessageId: run.replyRootMessageId ?? undefined,
  parentRunId: parseOptional(run.parentRunId, parseRunId),
  retriedFromWorkflowRunId: run.retriedFromWorkflowRunId ?? undefined,
  planId: run.planId ?? undefined,
  planStepId: run.planStepId ?? undefined,
  status: run.status,
  input: run.input ?? {},
  output: run.output ?? {},
  summary: run.summary ?? undefined,
  errorMessage: run.errorMessage ?? undefined,
  startedByActorType: run.startedByActorType,
  startedByActorId: run.startedByActorId,
  startedAt: run.startedAt?.toISOString(),
  finishedAt: run.finishedAt?.toISOString(),
  createdAt: run.createdAt.toISOString(),
  updatedAt: run.updatedAt.toISOString(),
})

export const mapWorkflowStepRun = (
  stepRun: WorkflowStepRunRow,
): WorkflowStepRunRecord => ({
  id: stepRun.id,
  workflowRunId: stepRun.workflowRunId,
  stepKey: stepRun.stepKey,
  stepType: stepRun.stepType,
  title: stepRun.title,
  sequence: stepRun.sequence,
  status: stepRun.status,
  input: stepRun.input ?? {},
  output: stepRun.output ?? {},
  errorMessage: stepRun.errorMessage ?? undefined,
  assignedAgentId: parseOptional(stepRun.assignedAgentId, parseAgentId),
  agentRunId: parseOptional(stepRun.agentRunId, parseRunId),
  taskId: stepRun.taskId ?? undefined,
  environmentInstanceId: stepRun.environmentInstance?.id ?? undefined,
  startedAt: stepRun.startedAt?.toISOString(),
  finishedAt: stepRun.finishedAt?.toISOString(),
  createdAt: stepRun.createdAt.toISOString(),
  updatedAt: stepRun.updatedAt.toISOString(),
})

// One shared pagination contract (docs/plans/2026-09-01-content-design-system/kit.md
// "Pagination — the one contract"): `data` + a `PaginationMeta` built by
// `buildPage`, same as every other keyset-paged list.
export type WorkflowListPage<T> = {
  data: T[]
  meta: PaginationMeta
}

export type WorkflowListInput = {
  cursor?: string
  direction?: PaginationDirection
  limit?: number
}
