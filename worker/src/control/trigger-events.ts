import type { PrismaClient } from '@prisma/client'
import { isJsonRecord } from '@nessie/runtime'
import type { TriggerEventDispatchJobPayload } from '@nessie/schemas'
import { queueTriggerRun, queueWorkflowTriggerRun } from './trigger-run.js'

const matchesEventTriggerConfig = (
  config: unknown,
  eventType: string,
  payload: Record<string, unknown>,
): boolean => {
  if (!isJsonRecord(config)) {
    return false
  }

  const configuredEvents = Array.isArray(config['events'])
    ? config['events'].filter((value): value is string => typeof value === 'string')
    : []
  if (!configuredEvents.includes(eventType)) {
    return false
  }

  const filter = isJsonRecord(config['filter']) ? config['filter'] : null
  if (!filter) {
    return true
  }

  return Object.entries(filter).every(([key, value]) => payload[key] === value)
}

export const dispatchEventTriggers = async (
  prisma: PrismaClient,
  input: TriggerEventDispatchJobPayload,
): Promise<void> => {
  const triggers = await prisma.agentTrigger.findMany({
    where: {
      enabled: true,
      status: 'active',
      type: 'event',
      OR: [
        {
          targetChannel: {
            is: {
              organizationId: input.actorContext.tenant.organizationId,
            },
          },
        },
        {
          workflowInstallation: {
            organizationId: input.actorContext.tenant.organizationId,
          },
        },
      ],
    },
    select: {
      agent: {
        select: {
          organizationId: true,
          projectId: true,
          teamId: true,
        },
      },
      agentId: true,
      config: true,
      id: true,
      targetChannelId: true,
      targetThreadId: true,
      type: true,
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

  for (const trigger of triggers) {
    if (!matchesEventTriggerConfig(trigger.config, input.eventType, input.payload)) {
      continue
    }

    const dedupeKey = input.dedupeKey ? `event:${trigger.id}:${input.dedupeKey}` : undefined
    const payload = {
      eventType: input.eventType,
      ...input.payload,
    }

    if (trigger.workflowInstallation) {
      await queueWorkflowTriggerRun(prisma, {
        dedupeKey,
        payload,
        source: input.source,
        trigger: {
          id: trigger.id,
          type: trigger.type,
          workflowInstallation: trigger.workflowInstallation,
        },
      })
      continue
    }

    if (!trigger.agentId || !trigger.agent || !trigger.targetChannelId || !trigger.targetThreadId) {
      continue
    }

    const targetChannelId = trigger.targetChannelId
    const targetThreadId = trigger.targetThreadId
    const agentId = trigger.agentId
    const agent = trigger.agent

    await queueTriggerRun(prisma, {
      dedupeKey,
      payload,
      source: input.source,
      trigger: {
        agent,
        agentId,
        id: trigger.id,
        targetChannelId,
        targetThreadId,
        type: trigger.type,
      },
    })
  }
}
