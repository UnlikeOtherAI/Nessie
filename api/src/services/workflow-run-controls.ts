import { Prisma, type PrismaClient } from '@prisma/client'
import { releaseNextQueuedWorkflowRun, withWorkflowOverlapLock } from '@nessie/team-admin'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type {
  ExecutionEnvironmentTerminateJobPayload,
  WorkflowRunExecuteJobPayload,
} from '@nessie/schemas'

import type { WorkflowRunRecord, WorkflowStepRunRecord } from '../contracts.js'
import { enqueueQueueJob } from '../queue/pgqueue.js'
import { mapWorkflowRun, mapWorkflowStepRun } from './workflow-records.js'
import {
  canBlockWorkflowStepRun,
  canSkipWorkflowStepRun,
  canUnblockWorkflowStepRun,
  isActiveWorkflowRunStatus,
} from './workflow-runs.js'
import { WorkflowActionError } from './workflow-validation.js'

// Operator intervention in a run that is already live: cancel the run, or
// skip / block / unblock one of its steps. Each of these has to propagate to
// the work the run suspended rather than only flipping a row, which is why
// they sit together and apart from the create/read paths.

const TOOL_STEP_CANCEL_NOTICE =
  'may still execute: the tool call was already dispatched and its side effect cannot be recalled.'

// Cancelling a workflow run must propagate to the work it suspended, not just
// flip rows: a running agent step keeps a suspended child run alive, a running
// environment_launch step holds a live instance, and a running tool step may
// still land a side effect. Each running step records what was abandoned on
// its output so the surface is honest about what cancel did and did not stop.
export const cancelWorkflowRun = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  workflowRunId: string,
  input: { reason?: string } = {},
): Promise<WorkflowRunRecord | null> => {
  // The overlap lock keys on the installation; resolve it first (the
  // authoritative re-read happens inside the transaction).
  const cancelTarget = await prisma.workflowRun.findFirst({
    where: {
      id: workflowRunId,
      organizationId: actorContext.tenant.organizationId,
    },
    select: { installationId: true },
  })
  if (!cancelTarget) {
    return null
  }

  const result = await withWorkflowOverlapLock(prisma, cancelTarget.installationId, async (tx) => {
    const existing = await tx.workflowRun.findFirst({
      where: {
        id: workflowRunId,
        organizationId: actorContext.tenant.organizationId,
      },
      select: { id: true, status: true },
    })
    if (!existing) {
      return null
    }
    if (existing.status === 'completed' || existing.status === 'cancelled') {
      return tx.workflowRun.findUnique({ where: { id: workflowRunId } })
    }

    const now = new Date()
    const summary = input.reason?.trim() || 'Workflow run cancelled.'

    // Atomic transition guarded on a non-terminal status: a concurrent cancel
    // or a run that completed between the check above and here writes nothing
    // (count === 0); either way we return the current row rather than
    // clobbering a terminal state — and skip the propagation, which the
    // winning transition already owns.
    const runTransition = await tx.workflowRun.updateMany({
      where: {
        id: workflowRunId,
        status: { in: ['pending', 'running'] },
      },
      data: {
        status: 'cancelled',
        summary,
        errorMessage: summary,
        finishedAt: now,
      },
    })

    if (runTransition.count > 0) {
      // Pending and blocked steps never started: plain skip.
      await tx.workflowStepRun.updateMany({
        where: {
          workflowRunId,
          status: { in: ['pending', 'blocked'] },
        },
        data: {
          status: 'skipped',
          finishedAt: now,
          errorMessage: summary,
        },
      })

      // Running steps are skipped individually: each records on its output
      // exactly what was abandoned, and each child kind gets its propagation.
      const runningSteps = await tx.workflowStepRun.findMany({
        where: { workflowRunId, status: 'running' },
        select: {
          agentRunId: true,
          environmentInstance: { select: { id: true } },
          id: true,
          output: true,
          stepType: true,
        },
      })

      for (const step of runningSteps) {
        const abandoned: Record<string, unknown> = {}
        let errorMessage = summary

        if (step.stepType === 'agent' && step.agentRunId) {
          // Cooperative cancellation (the runs.ts mechanism): the child
          // agentic loop observes cancelRequestedAt and terminalizes itself.
          await tx.run.updateMany({
            where: { id: step.agentRunId, status: 'running' },
            data: {
              cancelRequestedAt: now,
              cancelRequestedByUserId:
                actorContext.actor.actorType === 'user' ? actorContext.actor.actorId : null,
            },
          })
          // Name the queued mailbox message whose delivery this cancel
          // abandoned: the dispatch poller would otherwise keep claiming it
          // for a step that no longer exists.
          const abandonedMessage = await tx.agentMailboxMessage.findFirst({
            where: { workflowStepRunId: step.id, status: 'queued' },
            orderBy: [{ visibleAt: 'asc' }, { createdAt: 'asc' }],
            select: { id: true },
          })
          if (abandonedMessage) {
            abandoned['cancelAbandonedMessageId'] = abandonedMessage.id
          }
        }

        if (step.stepType === 'environment_launch' && step.environmentInstance) {
          const payload: ExecutionEnvironmentTerminateJobPayload = {
            actorContext,
            instanceId: step.environmentInstance.id,
          }
          await enqueueQueueJob(tx, {
            idempotencyKey: `execution-environment:terminate:${step.environmentInstance.id}`,
            payload,
            topic: 'execution.environment.terminate',
          })
        }

        if (step.stepType === 'tool' || step.stepType === 'tool_call') {
          abandoned['cancelAbandonedAt'] = now.toISOString()
          errorMessage = `${summary} ${TOOL_STEP_CANCEL_NOTICE}`
        }

        const existingOutput =
          step.output && typeof step.output === 'object' && !Array.isArray(step.output)
            ? (step.output as Record<string, unknown>)
            : {}

        await tx.workflowStepRun.update({
          where: { id: step.id },
          data: {
            status: 'skipped',
            finishedAt: now,
            errorMessage,
            output: { ...existingOutput, ...abandoned } as Prisma.InputJsonValue,
          },
        })
      }
      // W26: the cancelled run freed the installation's slot; release one
      // withheld pending run and enqueue it inside the same lock.
      const released = await releaseNextQueuedWorkflowRun(tx, cancelTarget.installationId)
      if (released) {
        await enqueueQueueJob(tx, {
          idempotencyKey: `workflow-run:start:${released.id}`,
          payload: { workflowRunId: released.id },
          topic: 'workflow.run.execute',
        })
      }
    }

    return tx.workflowRun.findUnique({ where: { id: workflowRunId } })
  })

  return result ? mapWorkflowRun(result) : null
}

type StepActionContext = {
  prisma: PrismaClient
  actorContext: AuthorizedActionContext
  workflowStepRunId: string
  reason?: string
}

type StepRunSelection = {
  id: string
  status: 'blocked' | 'completed' | 'failed' | 'pending' | 'running' | 'skipped'
  workflowRun: {
    id: string
    organizationId: string
    status: 'cancelled' | 'completed' | 'failed' | 'pending' | 'running'
  }
}

const loadWorkflowStepRunForAction = async (
  tx: Prisma.TransactionClient,
  organizationId: string,
  workflowStepRunId: string,
): Promise<StepRunSelection | null> => {
  const row = await tx.workflowStepRun.findFirst({
    where: {
      id: workflowStepRunId,
      workflowRun: { organizationId },
    },
    select: {
      id: true,
      status: true,
      workflowRun: {
        select: {
          id: true,
          organizationId: true,
          status: true,
        },
      },
    },
  })
  return row
}

const enqueueWorkflowExecute = async (
  tx: Prisma.TransactionClient,
  actorContext: AuthorizedActionContext,
  workflowRunId: string,
  suffix: string,
): Promise<void> => {
  const payload: WorkflowRunExecuteJobPayload = {
    actorContext,
    workflowRunId,
  }
  await enqueueQueueJob(tx, {
    idempotencyKey: `workflow-run:${suffix}:${workflowRunId}:${Date.now()}`,
    payload,
    topic: 'workflow.run.execute',
  })
}

export const skipWorkflowStepRun = async (
  ctx: StepActionContext,
): Promise<WorkflowStepRunRecord | null> => {
  const result = await ctx.prisma.$transaction(async (tx) => {
    const existing = await loadWorkflowStepRunForAction(
      tx,
      ctx.actorContext.tenant.organizationId,
      ctx.workflowStepRunId,
    )
    if (!existing) {
      return null
    }
    if (
      !canSkipWorkflowStepRun({
        runStatus: existing.workflowRun.status,
        stepStatus: existing.status,
      })
    ) {
      if (!isActiveWorkflowRunStatus(existing.workflowRun.status)) {
        throw new WorkflowActionError('WORKFLOW_RUN_NOT_ACTIVE', 'Workflow run is not active')
      }
      throw new WorkflowActionError(
        'WORKFLOW_STEP_RUN_NOT_SKIPPABLE',
        'Only pending or blocked steps can be skipped',
      )
    }

    const summary = ctx.reason?.trim() || 'Workflow step skipped by operator.'
    // Atomic transition: guard on the skippable statuses so a concurrent
    // skip/block/execution write cannot be clobbered. count === 0 means the
    // step already moved on; return its current row without re-enqueuing.
    const { count } = await tx.workflowStepRun.updateMany({
      where: {
        id: ctx.workflowStepRunId,
        status: { in: ['pending', 'blocked'] },
      },
      data: {
        status: 'skipped',
        errorMessage: summary,
        finishedAt: new Date(),
      },
    })

    const updated = await tx.workflowStepRun.findUnique({
      where: { id: ctx.workflowStepRunId },
      include: {
        environmentInstance: { select: { id: true } },
      },
    })

    if (count > 0) {
      await enqueueWorkflowExecute(tx, ctx.actorContext, existing.workflowRun.id, 'step-skip')
    }

    return updated
  })

  return result ? mapWorkflowStepRun(result) : null
}

export const blockWorkflowStepRun = async (
  ctx: StepActionContext,
): Promise<WorkflowStepRunRecord | null> => {
  const result = await ctx.prisma.$transaction(async (tx) => {
    const existing = await loadWorkflowStepRunForAction(
      tx,
      ctx.actorContext.tenant.organizationId,
      ctx.workflowStepRunId,
    )
    if (!existing) {
      return null
    }
    if (
      !canBlockWorkflowStepRun({
        runStatus: existing.workflowRun.status,
        stepStatus: existing.status,
      })
    ) {
      if (!isActiveWorkflowRunStatus(existing.workflowRun.status)) {
        throw new WorkflowActionError('WORKFLOW_RUN_NOT_ACTIVE', 'Workflow run is not active')
      }
      throw new WorkflowActionError(
        'WORKFLOW_STEP_RUN_NOT_BLOCKABLE',
        'Only pending steps can be blocked',
      )
    }

    const summary = ctx.reason?.trim() || 'Workflow step blocked by operator.'
    // Atomic transition guarded on `status === 'pending'`; a concurrent
    // block/skip/execution write that already moved the step leaves count === 0
    // and we just return the current row.
    await tx.workflowStepRun.updateMany({
      where: {
        id: ctx.workflowStepRunId,
        status: 'pending',
      },
      data: {
        status: 'blocked',
        errorMessage: summary,
      },
    })

    return tx.workflowStepRun.findUnique({
      where: { id: ctx.workflowStepRunId },
      include: {
        environmentInstance: { select: { id: true } },
      },
    })
  })

  return result ? mapWorkflowStepRun(result) : null
}

export const unblockWorkflowStepRun = async (
  ctx: StepActionContext,
): Promise<WorkflowStepRunRecord | null> => {
  const result = await ctx.prisma.$transaction(async (tx) => {
    const existing = await loadWorkflowStepRunForAction(
      tx,
      ctx.actorContext.tenant.organizationId,
      ctx.workflowStepRunId,
    )
    if (!existing) {
      return null
    }
    if (
      !canUnblockWorkflowStepRun({
        runStatus: existing.workflowRun.status,
        stepStatus: existing.status,
      })
    ) {
      if (!isActiveWorkflowRunStatus(existing.workflowRun.status)) {
        throw new WorkflowActionError('WORKFLOW_RUN_NOT_ACTIVE', 'Workflow run is not active')
      }
      throw new WorkflowActionError(
        'WORKFLOW_STEP_RUN_NOT_UNBLOCKABLE',
        'Only blocked steps can be unblocked',
      )
    }

    // Atomic transition guarded on `status === 'blocked'`. count === 0 means a
    // concurrent unblock/skip already moved the step; skip the re-enqueue and
    // return the current row.
    const { count } = await tx.workflowStepRun.updateMany({
      where: {
        id: ctx.workflowStepRunId,
        status: 'blocked',
      },
      data: {
        status: 'pending',
        errorMessage: null,
      },
    })

    const updated = await tx.workflowStepRun.findUnique({
      where: { id: ctx.workflowStepRunId },
      include: {
        environmentInstance: { select: { id: true } },
      },
    })

    if (count > 0) {
      await enqueueWorkflowExecute(tx, ctx.actorContext, existing.workflowRun.id, 'step-unblock')
    }

    return updated
  })

  return result ? mapWorkflowStepRun(result) : null
}
