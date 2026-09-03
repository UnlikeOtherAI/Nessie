import { Prisma, type PrismaClient } from '@prisma/client'
import {
  WORKFLOW_OVERLAP_SKIP_REASON,
  admitWorkflowRunUnderOverlap,
  collectWorkflowTaintedRefs,
  parseWorkflowConcurrency,
  redactWorkflowSecretValues,
  resolveInstallationPinnedGraph,
  withWorkflowOverlapLock,
} from '@nessie/team-admin'
import { buildPage, decodeKeysetCursor, resolvePageLimit } from '@nessie/schemas'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { WorkflowRunExecuteJobPayload } from '@nessie/schemas'

import type { WorkflowRunRecord, WorkflowStepRunRecord } from '../contracts.js'
import { enqueueQueueJob } from '../queue/pgqueue.js'
import {
  mapWorkflowRun,
  mapWorkflowStepRun,
  type WorkflowListPage,
  type WorkflowRunRow,
} from './workflow-records.js'
import { validateWorkflowRunReferences } from './workflow-references.js'
import { isWorkflowInstallationStartable } from './workflow-templates.js'
import { WorkflowActionError } from './workflow-validation.js'

// The workflow run record itself: the two entrypoints that create one under
// the installation's overlap policy (start, retry) and the two reads. Operator
// interventions on a live run live in workflow-run-controls.ts.

export const createWorkflowRun = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  installationId: string,
  input: {
    input?: Record<string, unknown>
    originChannelId?: string
    originMessageId?: string
    originThreadId?: string
    parentRunId?: string
    planId?: string
    planStepId?: string
    replyRootMessageId?: string
    triggerDeliveryId?: string
    triggerId?: string
  },
): Promise<WorkflowRunRecord | null> => {
  const result = await withWorkflowOverlapLock(prisma, installationId, async (tx) => {
    const installation = await tx.workflowInstallation.findFirst({
      where: {
        id: installationId,
        organizationId: actorContext.tenant.organizationId,
        active: true,
        status: {
          in: ['active', 'draft'],
        },
      },
      select: {
        active: true,
        concurrency: true,
        id: true,
        organizationId: true,
        status: true,
      },
    })
    if (installation && !isWorkflowInstallationStartable(installation)) {
      // A contradictory legacy row (paused-but-active, disabled-but-active)
      // fails closed rather than starting a run.
      return null
    }
    if (!installation) {
      return null
    }

    await validateWorkflowRunReferences(tx, installation.organizationId, input)

    // W26: manual runs respect the same overlap policy as trigger fires —
    // enforcing only in the trigger path would be a trivial bypass. A skipped
    // admission throws so the route can answer 409 with the recorded reason;
    // a withheld one returns its pending run and is released by the active
    // run's terminal transition.
    const admission = await admitWorkflowRunUnderOverlap(tx, {
      concurrency: parseWorkflowConcurrency(installation.concurrency),
      installationId: installation.id,
    })
    if (admission.kind === 'skip') {
      throw new WorkflowActionError(
        'WORKFLOW_RUN_OVERLAP_SKIPPED',
        `Workflow run skipped: the installation's overlap policy is at capacity (${WORKFLOW_OVERLAP_SKIP_REASON})`,
      )
    }

    const run = await tx.workflowRun.create({
      data: {
        installationId: installation.id,
        organizationId: installation.organizationId,
        // W4: freeze the graph this run executes from.
        graphSnapshot: await resolveInstallationPinnedGraph(tx, installation.id),
        triggerId: input.triggerId,
        triggerDeliveryId: input.triggerDeliveryId,
        parentRunId: input.parentRunId,
        planId: input.planId,
        planStepId: input.planStepId,
        // W25: the origin is validated against the run's organization by
        // validateWorkflowRunReferences, exactly like every other reference.
        originChannelId: input.originChannelId,
        originThreadId: input.originThreadId,
        originMessageId: input.originMessageId,
        replyRootMessageId: input.replyRootMessageId,
        input: (input.input ?? {}) as Prisma.InputJsonValue,
        ...(admission.kind === 'withhold'
          ? { summary: `${WORKFLOW_OVERLAP_SKIP_REASON}:queued` }
          : {}),
        startedByActorType: actorContext.actor.actorType,
        startedByActorId: actorContext.actor.actorId,
      },
    })

    if (admission.kind === 'admit') {
      const payload: WorkflowRunExecuteJobPayload = {
        actorContext,
        workflowRunId: run.id,
      }
      await enqueueQueueJob(tx, {
        idempotencyKey: `workflow-run:start:${run.id}`,
        payload,
        topic: 'workflow.run.execute',
      })
    }

    return run
  })

  return result ? mapWorkflowRun(result) : null
}

export const listWorkflowRuns = async (
  prisma: PrismaClient,
  organizationId: string,
  input: {
    cursor?: string
    installationId?: string
    // W19: entitlement fragment over the run's installation; undefined means
    // "no additional filter" (owners/admins).
    installationWhere?: Prisma.WorkflowInstallationWhereInput
    limit?: number
    status?: 'cancelled' | 'completed' | 'failed' | 'pending' | 'running'
  },
): Promise<WorkflowListPage<WorkflowRunRecord>> => {
  // List view omits the large `input`/`output` Json blobs; they are only
  // fetched by the single-run GET. The contract still requires them, so the
  // list mapper substitutes empty objects.
  const limit = resolvePageLimit(input.limit)
  const where: Prisma.WorkflowRunWhereInput = {
    organizationId,
    ...(input.installationId ? { installationId: input.installationId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.installationWhere ? { installation: input.installationWhere } : {}),
  }
  const total = await prisma.workflowRun.count({ where })

  const parsed = decodeKeysetCursor(input.cursor)
  if (parsed) {
    const existingAnd = where.AND
    where.AND = [
      ...(Array.isArray(existingAnd) ? existingAnd : existingAnd ? [existingAnd] : []),
      {
        OR: [
          { createdAt: { lt: parsed.createdAt } },
          { createdAt: parsed.createdAt, id: { lt: parsed.id } },
        ],
      },
    ]
  }

  const runs = await prisma.workflowRun.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      installationId: true,
      organizationId: true,
      triggerId: true,
      triggerDeliveryId: true,
      parentRunId: true,
      retriedFromWorkflowRunId: true,
      originChannelId: true,
      originMessageId: true,
      originThreadId: true,
      replyRootMessageId: true,
      planId: true,
      planStepId: true,
      status: true,
      summary: true,
      errorMessage: true,
      startedByActorType: true,
      startedByActorId: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  const page = buildPage({ hasCursor: Boolean(parsed), limit, rows: runs, total })
  return {
    data: page.data.map((run) => mapWorkflowRun({ ...run, input: {}, output: {} })),
    meta: page.meta,
  }
}

type WorkflowRunStatusValue = 'cancelled' | 'completed' | 'failed' | 'pending' | 'running'
type WorkflowStepRunStatusValue =
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'pending'
  | 'running'
  | 'skipped'

export const isTerminalWorkflowRunStatus = (status: WorkflowRunStatusValue): boolean =>
  status === 'cancelled' || status === 'completed' || status === 'failed'

export const isActiveWorkflowRunStatus = (status: WorkflowRunStatusValue): boolean =>
  status === 'pending' || status === 'running'

export const canRetryWorkflowRun = (status: WorkflowRunStatusValue): boolean =>
  isTerminalWorkflowRunStatus(status)

export const canSkipWorkflowStepRun = (input: {
  runStatus: WorkflowRunStatusValue
  stepStatus: WorkflowStepRunStatusValue
}): boolean =>
  isActiveWorkflowRunStatus(input.runStatus) &&
  (input.stepStatus === 'pending' || input.stepStatus === 'blocked')

export const canBlockWorkflowStepRun = (input: {
  runStatus: WorkflowRunStatusValue
  stepStatus: WorkflowStepRunStatusValue
}): boolean => isActiveWorkflowRunStatus(input.runStatus) && input.stepStatus === 'pending'

export const canUnblockWorkflowStepRun = (input: {
  runStatus: WorkflowRunStatusValue
  stepStatus: WorkflowStepRunStatusValue
}): boolean => isActiveWorkflowRunStatus(input.runStatus) && input.stepStatus === 'blocked'

export const retryWorkflowRun = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  workflowRunId: string,
  input: { reason?: string } = {},
): Promise<WorkflowRunRecord | null> => {
  // The overlap lock keys on the installation, so resolve it first (the
  // authoritative re-read happens inside the transaction below).
  const runInstallation = await prisma.workflowRun.findFirst({
    where: {
      id: workflowRunId,
      organizationId: actorContext.tenant.organizationId,
    },
    select: { installationId: true },
  })
  if (!runInstallation) {
    return null
  }

  const result = await withWorkflowOverlapLock(prisma, runInstallation.installationId, async (tx) => {
    const existing = await tx.workflowRun.findFirst({
      where: {
        id: workflowRunId,
        organizationId: actorContext.tenant.organizationId,
      },
      select: {
        id: true,
        status: true,
        input: true,
        installationId: true,
        originChannelId: true,
        originMessageId: true,
        originThreadId: true,
        replyRootMessageId: true,
        startedByActorId: true,
        startedByActorType: true,
        triggerDeliveryId: true,
        triggerId: true,
      },
    })
    if (!existing) {
      return null
    }
    if (!canRetryWorkflowRun(existing.status)) {
      throw new WorkflowActionError(
        'WORKFLOW_RUN_NOT_TERMINAL',
        'Only terminal workflow runs can be retried',
      )
    }

    const installation = await tx.workflowInstallation.findFirst({
      where: {
        id: existing.installationId,
        organizationId: actorContext.tenant.organizationId,
        active: true,
        status: { in: ['active', 'draft'] },
      },
      select: { concurrency: true, id: true, organizationId: true },
    })
    if (!installation) {
      throw new WorkflowActionError(
        'WORKFLOW_INSTALLATION_INACTIVE',
        'Workflow installation is inactive and cannot accept retries',
      )
    }

    // W26: a retry is a new run and takes the same overlap admission as any
    // other entrypoint.
    const admission = await admitWorkflowRunUnderOverlap(tx, {
      concurrency: parseWorkflowConcurrency(installation.concurrency),
      installationId: installation.id,
    })
    if (admission.kind === 'skip') {
      throw new WorkflowActionError(
        'WORKFLOW_RUN_OVERLAP_SKIPPED',
        `Workflow run retry skipped: the installation's overlap policy is at capacity (${WORKFLOW_OVERLAP_SKIP_REASON})`,
      )
    }

    const summary = input.reason?.trim() || `Retry of workflow run ${existing.id}`

    const run = await tx.workflowRun.create({
      data: {
        installationId: installation.id,
        organizationId: installation.organizationId,
        triggerId: existing.triggerId,
        triggerDeliveryId: existing.triggerDeliveryId,
        retriedFromWorkflowRunId: existing.id,
        // W25: a retry answers the same origin as the run it replaces.
        originChannelId: existing.originChannelId,
        originThreadId: existing.originThreadId,
        originMessageId: existing.originMessageId,
        replyRootMessageId: existing.replyRootMessageId,
        graphSnapshot: await resolveInstallationPinnedGraph(tx, installation.id),
        input: (existing.input ?? {}) as Prisma.InputJsonValue,
        summary: admission.kind === 'withhold'
          ? `${WORKFLOW_OVERLAP_SKIP_REASON}:queued`
          : summary,
        // W27: the retry must not rewrite history — the run keeps its
        // original starter; the retrying actor is recorded alongside.
        startedByActorType: existing.startedByActorType,
        startedByActorId: existing.startedByActorId,
        retriedByActorType: actorContext.actor.actorType,
        retriedByActorId: actorContext.actor.actorId,
        retriedAt: new Date(),
      },
    })

    if (admission.kind === 'admit') {
      const payload: WorkflowRunExecuteJobPayload = {
        actorContext,
        workflowRunId: run.id,
      }
      await enqueueQueueJob(tx, {
        idempotencyKey: `workflow-run:start:${run.id}`,
        payload,
        topic: 'workflow.run.execute',
      })
    }

    return run
  })

  return result ? mapWorkflowRun(result) : null
}

export const getWorkflowRun = async (
  prisma: PrismaClient,
  organizationId: string,
  workflowRunId: string,
): Promise<{ run: WorkflowRunRecord; steps: WorkflowStepRunRecord[] } | null> => {
  const run = await prisma.workflowRun.findFirst({
    where: {
      id: workflowRunId,
      organizationId,
    },
    include: {
      installation: {
        select: {
          resolvedBindings: true,
          workflowTemplate: { select: { bindingSchema: true } },
        },
      },
    },
  })
  if (!run) {
    return null
  }

  const steps = await prisma.workflowStepRun.findMany({
    where: {
      workflowRunId,
    },
    include: {
      environmentInstance: {
        select: { id: true },
      },
    },
    orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }],
  })

  // W0 sinks 1+4: run JSON and persisted step artifacts (the §5 sample the
  // designer/replay reads) are redacted server-side. The boundary is the
  // response mapper, not the admin, so pre-boundary rows that already hold a
  // ref in `WorkflowStepRun.input` are covered too.
  const taintedRefs = collectWorkflowTaintedRefs(run.installation.resolvedBindings)
  const redactedRun: WorkflowRunRow = {
    ...run,
    input: redactWorkflowSecretValues(run.input, taintedRefs),
    output: redactWorkflowSecretValues(run.output, taintedRefs),
  }

  return {
    run: mapWorkflowRun(redactedRun),
    steps: steps.map((step) =>
      mapWorkflowStepRun({
        ...step,
        input: redactWorkflowSecretValues(step.input, taintedRefs),
        output: redactWorkflowSecretValues(step.output, taintedRefs),
      }),
    ),
  }
}
