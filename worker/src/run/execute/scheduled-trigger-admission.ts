import type { PrismaClient } from '@prisma/client'

import { recordTriggerHealthFailure } from '../../control/trigger-health.js'
import {
  assertTriggerRunAdmission,
} from '../../control/trigger-run-admission.js'
import { TriggerLaunchOriginError } from '../../control/trigger-origin.js'
import type { RunContext } from './types.js'

export type ScheduledRunAdmission = 'admitted' | 'cancelled'

/**
 * Last-moment admission for a scheduled run that waited in the queue or behind
 * another run. Dispatch-time checks cannot authorize work that starts later:
 * removing either channel member in that interval must still stop the schedule
 * before a provider or tool sees the saved prompt.
 */
export const revalidateScheduledTriggerRunAdmission = async (
  prisma: PrismaClient,
  context: RunContext,
): Promise<ScheduledRunAdmission> => {
  const triggerId = context.run.triggerId
  if (!triggerId) return 'admitted'

  const trigger = await prisma.agentTrigger.findUnique({
    where: { id: triggerId },
    select: {
      agent: {
        select: {
          agentKind: true,
          organizationId: true,
          projectId: true,
          teamId: true,
        },
      },
      agentId: true,
      config: true,
      enabled: true,
      status: true,
      targetChannelId: true,
      targetThreadId: true,
      type: true,
    },
  })
  if (!trigger) return 'cancelled'
  if (trigger.type !== 'scheduled' && trigger.type !== 'interval') return 'admitted'
  if (!trigger.enabled || trigger.status !== 'active') return 'cancelled'

  let admissionError: TriggerLaunchOriginError | null = null
  if (
    !trigger.agent
    || !trigger.agentId
    || !trigger.targetChannelId
    || !trigger.targetThreadId
    || trigger.agentId !== context.agent.id
    || trigger.targetThreadId !== context.run.threadId
  ) {
    admissionError = new TriggerLaunchOriginError(
      'agent_channel_access_lost',
      'its saved agent or target no longer matches the queued run',
    )
  } else {
    try {
      await assertTriggerRunAdmission(prisma, {
        agent: trigger.agent,
        agentId: trigger.agentId,
        config: trigger.config,
        targetChannelId: trigger.targetChannelId,
        targetThreadId: trigger.targetThreadId,
        triggerType: trigger.type,
      })
    } catch (error) {
      if (!(error instanceof TriggerLaunchOriginError)) throw error
      admissionError = error
    }
  }

  if (!admissionError) return 'admitted'

  await recordTriggerHealthFailure(prisma, {
    error: admissionError,
    triggerId,
  })
  if (context.run.triggerDeliveryId) {
    await prisma.agentTriggerDelivery.updateMany({
      where: { id: context.run.triggerDeliveryId },
      data: {
        errorMessage: admissionError.message,
        nextRetryAt: null,
        status: 'failed',
      },
    })
  }
  return 'cancelled'
}
