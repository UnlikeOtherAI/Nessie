import type { PrismaClient } from '@prisma/client'
import {
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type AuthorizedActionContext,
  type TriggerEventDispatchJobPayload,
  type WorkflowRunFailureDispatchJobPayload,
} from '@nessie/schemas'
import { enqueueQueueJob } from '../queue.js'

// Emits system events (`workflow.run.completed` / `workflow.run.failed`) when a
// workflow run reaches a terminal state, so existing `type: 'event'` triggers
// whose `config.events` include the event name can fire "error workflows".
// Split from control/workflows.ts to keep that file from growing further past
// the 500-line cap (AGENTS.md); this module owns only the terminal-event shape
// and its (non-fatal) enqueue.

export type WorkflowRunTerminalStatus = 'completed' | 'failed'

export type WorkflowRunEventContext = {
  channelId?: string | null
  organizationId: string
  projectId?: string | null
  startedByActorId: string
  startedByActorType: string
  teamId?: string | null
  workflowInstallationId: string
  workflowRunId: string
  workflowTemplateId?: string | null
}

// Shape of the `loadWorkflowGraph` result that carries the fields needed to
// build the terminal-event context. Kept as a narrow structural type (rather
// than importing the concrete return type) so this module has no dependency
// on `run/workflows.ts`.
export type WorkflowGraphForEvents = {
  installation: {
    channelId: string | null
    id: string
    projectId: string | null
    teamId: string | null
    workflowTemplateId?: string | null
  }
  run: {
    id: string
    organizationId: string
    startedByActorId: string
    startedByActorType: string
  }
}

export const buildWorkflowRunEventContext = (
  workflow: WorkflowGraphForEvents,
): WorkflowRunEventContext => ({
  channelId: workflow.installation.channelId,
  organizationId: workflow.run.organizationId,
  projectId: workflow.installation.projectId,
  startedByActorId: workflow.run.startedByActorId,
  startedByActorType: workflow.run.startedByActorType,
  teamId: workflow.installation.teamId,
  workflowInstallationId: workflow.installation.id,
  workflowRunId: workflow.run.id,
  workflowTemplateId: workflow.installation.workflowTemplateId,
})

const parseWorkflowEventActorType = (value: string): 'agent' | 'service' | 'user' =>
  value === 'agent' || value === 'service' || value === 'user' ? value : 'service'

export type WorkflowRunTerminalEventJob = {
  idempotencyKey: string
  payload: TriggerEventDispatchJobPayload
  topic: 'trigger.event.dispatch'
}

// Pure builder: turns the run context + terminal status into the exact
// `trigger.event.dispatch` job shape the worker's `dispatchEventTriggers`
// consumer (control/trigger-events.ts) expects. No I/O, so it is unit
// testable without a database.
export const buildWorkflowRunTerminalEventPayload = (
  context: WorkflowRunEventContext,
  status: WorkflowRunTerminalStatus,
  errorMessage?: string | null,
): WorkflowRunTerminalEventJob => {
  const eventType = status === 'completed' ? 'workflow.run.completed' : 'workflow.run.failed'
  const dedupeKey = `workflow-run-event:${context.workflowRunId}:${status}`

  const actorContext: AuthorizedActionContext = {
    actor: {
      actorId: context.startedByActorId,
      actorType: parseWorkflowEventActorType(context.startedByActorType),
    },
    tenant: {
      organizationId: parseOrganizationId(context.organizationId),
      ...(context.projectId ? { projectId: parseProjectId(context.projectId) } : {}),
      ...(context.teamId ? { teamId: parseTeamId(context.teamId) } : {}),
      ...(context.channelId ? { channelId: parseChannelId(context.channelId) } : {}),
    },
    actionContext: {
      requestId: dedupeKey,
      correlationId: context.workflowRunId,
      ...(context.channelId ? { channelId: parseChannelId(context.channelId) } : {}),
      purpose: 'workflow.run.terminal_event',
      sessionId: context.workflowRunId,
    },
  }

  const payload: TriggerEventDispatchJobPayload = {
    actorContext,
    dedupeKey,
    eventType,
    payload: {
      errorMessage: status === 'failed' ? (errorMessage ?? null) : undefined,
      organizationId: context.organizationId,
      status,
      workflowInstallationId: context.workflowInstallationId,
      workflowRunId: context.workflowRunId,
      workflowTemplateId: context.workflowTemplateId ?? undefined,
    },
    source: `workflow-run:${context.workflowRunId}`,
  }

  return {
    idempotencyKey: `trigger-event:${context.organizationId}:${dedupeKey}`,
    payload,
    topic: 'trigger.event.dispatch',
  }
}

// Enqueues the terminal event, scoped to the run's organization. Failures are
// logged, never thrown — a lost notification must not fail run bookkeeping
// that already committed.
export const emitWorkflowRunTerminalEvent = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  context: WorkflowRunEventContext,
  status: WorkflowRunTerminalStatus,
  errorMessage?: string | null,
): Promise<void> => {
  try {
    const job = buildWorkflowRunTerminalEventPayload(context, status, errorMessage)
    await enqueueQueueJob(prisma, {
      idempotencyKey: job.idempotencyKey,
      payload: job.payload,
      topic: job.topic,
    })
    if (status === 'failed') {
      // W23: the failure also reaches a human through the push pipeline. The
      // payload carries ids only — no raw error or input data.
      const failureDispatch: WorkflowRunFailureDispatchJobPayload = {
        organizationId: context.organizationId,
        workflowInstallationId: context.workflowInstallationId,
        workflowRunId: context.workflowRunId,
      }
      await enqueueQueueJob(prisma, {
        idempotencyKey: `workflow-run-failure:${context.workflowRunId}`,
        payload: failureDispatch,
        topic: 'workflow.run.failure-dispatch',
      })
    }
  } catch (error) {
    console.error('[workflow-run-events] failed to enqueue workflow run terminal event', {
      error,
      status,
      workflowRunId: context.workflowRunId,
    })
  }
}
