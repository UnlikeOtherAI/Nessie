import { type PrismaClient } from '@prisma/client'
import { type AgentTriggerType } from '@nessie/schemas'
import { queueTriggerRun } from './trigger-run.js'
import { queueWorkflowTriggerRun } from './workflow-trigger-run.js'

// sp-webhook: re-attempt a previously-failed trigger delivery. Loads the trigger
// fresh and routes to the agent or workflow queue path, reusing the existing
// delivery row so backoff state accumulates on the same record. The signature
// matches the `RetryReattempt` contract consumed by
// `retryFailedTriggerDeliveries` in `trigger-delivery-retry.ts`.
export const reattemptTriggerDelivery = async (
  prisma: PrismaClient,
  input: {
    dedupeKey?: string
    payload: unknown
    reuseDeliveryId: string
    retryCount: number
    source: string
    triggerId: string
    type: AgentTriggerType
  },
): Promise<void> => {
  const trigger = await prisma.agentTrigger.findUnique({
    where: { id: input.triggerId },
    include: {
      agent: {
        select: {
          id: true,
          agentKind: true,
          organizationId: true,
          projectId: true,
          teamId: true,
        },
      },
      workflowInstallation: {
        select: {
          active: true,
          channelId: true,
          id: true,
          organizationId: true,
          projectId: true,
          status: true,
          teamId: true,
        },
      },
    },
  })

  // A terminal scheduled occurrence has no next run and can be paused while
  // its already-persisted delivery is retrying. That delivery predates the
  // pause, so it remains owed. Other disabled/error/paused triggers stop
  // retries as before, including an operator pause that retains nextRunAt.
  const terminalScheduledOccurrence =
    trigger?.enabled
    && trigger.status === 'paused'
    && trigger.nextRunAt === null
    && (trigger.type === 'scheduled' || trigger.type === 'interval')
  if (
    !trigger
    || !trigger.enabled
    || (trigger.status !== 'active' && !terminalScheduledOccurrence)
  ) {
    await prisma.agentTriggerDelivery.update({
      where: { id: input.reuseDeliveryId },
      data: { nextRetryAt: null },
    })
    return
  }

  const retry = { retryCount: input.retryCount, reuseDeliveryId: input.reuseDeliveryId }

  if (trigger.workflowInstallationId && trigger.workflowInstallation) {
    await queueWorkflowTriggerRun(prisma, {
      dedupeKey: input.dedupeKey,
      payload: input.payload,
      retry,
      source: input.source,
      trigger: {
        id: trigger.id,
        type: trigger.type,
        workflowInstallation: trigger.workflowInstallation,
      },
    })
    return
  }

  if (!trigger.agent || !trigger.targetChannelId || !trigger.targetThreadId) {
    await prisma.agentTriggerDelivery.update({
      where: { id: input.reuseDeliveryId },
      data: { nextRetryAt: null },
    })
    return
  }

  await queueTriggerRun(prisma, {
    dedupeKey: input.dedupeKey,
    payload: input.payload,
    retry,
    source: input.source,
    trigger: {
      agent: {
        agentKind: trigger.agent.agentKind,
        organizationId: trigger.agent.organizationId,
        projectId: trigger.agent.projectId,
        teamId: trigger.agent.teamId,
      },
      agentId: trigger.agent.id,
      config: trigger.config,
      id: trigger.id,
      targetChannelId: trigger.targetChannelId,
      targetThreadId: trigger.targetThreadId,
      type: trigger.type,
    },
  })
}
