import { Prisma, type PrismaClient } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import type { AuthorizedActionContext, WorkflowRunExecuteJobPayload } from '@nessie/schemas'

import {
  WORKFLOW_OVERLAP_SKIP_REASON,
  admitWorkflowRunUnderOverlap,
  parseWorkflowConcurrency,
  withWorkflowOverlapLock,
} from './workflow-concurrency.js'
import { resolveInstallationPinnedGraph } from './workflow-graph-pin.js'
import {
  validateWorkflowRunReferences,
  type WorkflowRunReferenceInput,
} from './workflow-run-references.js'

export type WorkflowRunStartInput = WorkflowRunReferenceInput & {
  input?: Record<string, unknown>
}

export class WorkflowRunOverlapError extends Error {
  readonly code = 'WORKFLOW_RUN_OVERLAP_SKIPPED'

  constructor() {
    super(
      `Workflow run skipped: the installation's overlap policy is at capacity (${WORKFLOW_OVERLAP_SKIP_REASON})`,
    )
    this.name = 'WorkflowRunOverlapError'
  }
}

/**
 * The manual-start action behind both the installation route and PA. The
 * queue row is written in the same transaction as the run, so either surface
 * has the same admission, graph pinning, reference checks, and recovery path.
 */
export const startWorkflowRunForActor = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  installationId: string,
  input: WorkflowRunStartInput,
) => {
  return withWorkflowOverlapLock(prisma, installationId, async (tx) => {
    const installation = await tx.workflowInstallation.findFirst({
      where: {
        id: installationId,
        organizationId: actorContext.tenant.organizationId,
        active: true,
        status: { in: ['active', 'draft'] },
      },
      select: { concurrency: true, id: true, organizationId: true },
    })
    if (!installation) return null

    await validateWorkflowRunReferences(tx, installation.organizationId, input)
    const admission = await admitWorkflowRunUnderOverlap(tx, {
      concurrency: parseWorkflowConcurrency(installation.concurrency),
      installationId: installation.id,
    })
    if (admission.kind === 'skip') throw new WorkflowRunOverlapError()

    const run = await tx.workflowRun.create({
      data: {
        installationId: installation.id,
        organizationId: installation.organizationId,
        graphSnapshot: await resolveInstallationPinnedGraph(tx, installation.id),
        triggerId: input.triggerId,
        triggerDeliveryId: input.triggerDeliveryId,
        parentRunId: input.parentRunId,
        planId: input.planId,
        planStepId: input.planStepId,
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
      const payload: WorkflowRunExecuteJobPayload = { actorContext, workflowRunId: run.id }
      await enqueueQueueJob(tx, {
        idempotencyKey: `workflow-run:start:${run.id}`,
        payload,
        topic: 'workflow.run.execute',
      })
    }
    return run
  })
}
