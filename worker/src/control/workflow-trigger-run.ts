import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import {
  type AgentTriggerType,
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type AuthorizedActionContext,
  type WorkflowRunExecuteJobPayload,
} from '@nessie/schemas'
import {
  WORKFLOW_OVERLAP_SKIP_REASON,
  admitWorkflowRunUnderOverlap,
  parseWorkflowConcurrency,
  resolveInstallationPinnedGraph,
  withWorkflowOverlapLock,
} from '@nessie/workspace-admin'
import { enqueueQueueJob } from '../queue.js'
import { recordDeliveryFailure } from './trigger-delivery-retry.js'
import {
  normalizePayload,
  upsertDelivery,
  type RetryContext,
} from './trigger-run.js'

// Workflow-installation triggers fire a WorkflowRun rather than a direct agent
// run, so they are not part of the per-(agent, thread) run serialization in
// trigger-run.ts. Split out of trigger-run.ts to keep both files under the
// 500-line cap; the shared fire-primitives stay there.
export const queueWorkflowTriggerRun = async (
  prisma: PrismaClient,
  input: {
    dedupeKey?: string
    payload: unknown
    retry?: RetryContext
    source: string
    trigger: {
      id: string
      type: AgentTriggerType
      workflowInstallation: {
        active: boolean
        channelId: string | null
        id: string
        organizationId: string
        status: 'active' | 'disabled' | 'draft' | 'paused'
        projectId: string | null
        teamId: string | null
      }
    }
  },
): Promise<void> => {
  const installation = input.trigger.workflowInstallation
  // W8: `paused` must actually pause. Only an unambiguous active
  // installation fires — one lifecycle read, shared with the API.
  if (installation.status !== 'active' || !installation.active) {
    return
  }

  const existingDelivery = input.dedupeKey
    ? await prisma.agentTriggerDelivery.findFirst({
        where: {
          dedupeKey: input.dedupeKey,
          triggerId: input.trigger.id,
        },
        include: {
          workflowRuns: {
            select: { id: true },
            take: 1,
          },
        },
      })
    : null

  if (existingDelivery?.workflowRuns[0]?.id) {
    return
  }

  const actorContext: AuthorizedActionContext = {
    actor: {
      actorId: installation.id,
      actorType: 'service',
      roles: ['system'],
    },
    actionContext: {
      ...(installation.channelId
        ? { channelId: parseChannelId(installation.channelId) }
        : {}),
      purpose: `trigger:${input.trigger.type}`,
      requestId: randomUUID(),
      correlationId: `trigger:${input.trigger.id}`,
    },
    tenant: {
      organizationId: parseOrganizationId(installation.organizationId),
      projectId: installation.projectId ? parseProjectId(installation.projectId) : undefined,
      teamId: installation.teamId ? parseTeamId(installation.teamId) : undefined,
    },
  }

  const normalizedPayload = normalizePayload(input.payload)
  try {
    // W26: the overlap decision runs under the per-installation advisory
    // lock, so two fires landing together serialize on the active-run count.
    await withWorkflowOverlapLock(prisma, installation.id, async (tx) => {
      const delivery = await upsertDelivery(tx, {
        dedupeKey: input.dedupeKey,
        payload: normalizedPayload,
        retry: input.retry,
        source: input.source,
        triggerId: input.trigger.id,
      })

      const installationRow = await tx.workflowInstallation.findUnique({
        where: { id: installation.id },
        select: { concurrency: true },
      })
      const admission = await admitWorkflowRunUnderOverlap(tx, {
        concurrency: parseWorkflowConcurrency(installationRow?.concurrency),
        installationId: installation.id,
      })

      if (admission.kind === 'skip') {
        // A silent skip is undiagnosable; the delivery records why nothing ran.
        await tx.agentTriggerDelivery.update({
          where: { id: delivery.id },
          data: {
            errorMessage: WORKFLOW_OVERLAP_SKIP_REASON,
            status: 'skipped_overlap',
          },
        })
        await tx.agentTrigger.update({
          where: { id: input.trigger.id },
          data: {
            lastFiredAt: new Date(),
          },
        })
        return
      }

      const pinnedGraph = await resolveInstallationPinnedGraph(tx, installation.id)

      const workflowRun = await tx.workflowRun.create({
        data: {
          installationId: installation.id,
          organizationId: installation.organizationId,
          // W4: freeze the installed graph this run executes from.
          graphSnapshot: pinnedGraph,
          triggerId: input.trigger.id,
          triggerDeliveryId: delivery.id,
          // W25: trigger fires originate in the installation's channel.
          originChannelId: installation.channelId,
          input: (input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
            ? (input.payload as Record<string, unknown>)
            : { payload: input.payload ?? null }) as Prisma.InputJsonValue,
          // W26 `queue`: the run is recorded but withheld — no execute job —
          // until the active run's terminal transition releases the slot.
          ...(admission.kind === 'withhold'
            ? { summary: `${WORKFLOW_OVERLAP_SKIP_REASON}:queued` }
            : {}),
          startedByActorType: actorContext.actor.actorType,
          startedByActorId: actorContext.actor.actorId,
        },
        select: { id: true },
      })

      if (admission.kind === 'admit') {
        const jobPayload: WorkflowRunExecuteJobPayload = {
          actorContext,
          workflowRunId: workflowRun.id,
        }
        await enqueueQueueJob(tx, {
          idempotencyKey: `workflow-run:start:${workflowRun.id}`,
          payload: jobPayload,
          topic: 'workflow.run.execute',
        })
      }

      await tx.agentTriggerDelivery.update({
        where: { id: delivery.id },
        data: {
          deliveredAt: new Date(),
          status: 'delivered',
        },
      })

      await tx.agentTrigger.update({
        where: { id: input.trigger.id },
        data: {
          lastFiredAt: new Date(),
        },
      })
    })
  } catch (error) {
    if (
      input.dedupeKey &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return
    }
    // sp-webhook: persist a retryable failed delivery (outside the rolled-back
    // tx) so the retry poller can re-attempt with backoff.
    await recordDeliveryFailure(prisma, {
      dedupeKey: input.dedupeKey,
      error,
      existingDeliveryId: input.retry?.reuseDeliveryId,
      payload: normalizedPayload,
      retryCount: input.retry?.retryCount ?? 0,
      source: input.source,
      triggerId: input.trigger.id,
    })
    throw error
  }
}
