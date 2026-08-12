import { Prisma, type PrismaClient } from '@prisma/client'
import {
  ScheduledTriggerLaunchOriginSchema,
  type AgentTriggerRecord,
  type AgentTriggerType,
  type ScheduledTriggerLaunchOrigin,
} from '@nessie/schemas'

import {
  ensureWebhookConfig,
  mapTriggerRecord,
  normalizeNextRunAt,
  resolveExecutionTarget,
  SCHEDULER_TRIGGER_TYPES,
} from './trigger-core.js'
import { stripServerOwnedTriggerConfig } from './trigger-config-identity.js'

/**
 * Create a trigger on an agent. Shared by `POST /api/agents/:agentId/triggers`
 * and the personal assistant's `agent_trigger_create` tool: `launchOrigin` is a
 * trusted, caller-supplied argument in both, because only the surface holding a
 * live session can say which user and UOA workspace a future fire inherits.
 */
export const createAgentTrigger = async (
  prisma: PrismaClient,
  agentId: string,
  input: {
    config?: Record<string, unknown>
    description?: string
    enabled?: boolean
    name?: string
    nextRunAt?: string
    targetChannelId?: string
    targetThreadId?: string
    type: AgentTriggerType
  },
  trusted: {
    launchOrigin?: ScheduledTriggerLaunchOrigin
  } = {},
): Promise<AgentTriggerRecord | null> => {
  const clientConfig = stripServerOwnedTriggerConfig(input.config)
  const isScheduled = SCHEDULER_TRIGGER_TYPES.includes(input.type)
  const parsedLaunchOrigin = isScheduled
    ? ScheduledTriggerLaunchOriginSchema.safeParse(trusted.launchOrigin)
    : null
  if (parsedLaunchOrigin && !parsedLaunchOrigin.success) {
    return null
  }
  const launchOrigin = parsedLaunchOrigin?.success
    ? parsedLaunchOrigin.data
    : undefined
  const normalizedConfig = input.type === 'webhook'
    ? ensureWebhookConfig(clientConfig)
    : {
        ...clientConfig,
        ...(launchOrigin
          ? {
              createdByUserId: launchOrigin.userId,
              launchOrigin,
            }
          : {}),
      }

  const normalizedNextRunAt = normalizeNextRunAt({
    config: normalizedConfig,
    nextRunAt: input.nextRunAt,
    type: input.type,
  })
  if (SCHEDULER_TRIGGER_TYPES.includes(input.type) && !normalizedNextRunAt) {
    return null
  }

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      id: true,
      agentKind: true,
      organizationId: true,
    },
  })

  if (!agent || agent.agentKind === 'personal_assistant') {
    return null
  }
  if (isScheduled) {
    if (!launchOrigin) {
      return null
    }
    if (agent.organizationId !== launchOrigin.organizationId) {
      return null
    }
    const launchTeam = await prisma.team.findFirst({
      where: {
        id: launchOrigin.teamId,
        ...(launchOrigin.projectId
          ? { projectId: launchOrigin.projectId }
          : {}),
        members: { some: { userId: launchOrigin.userId } },
        project: { organizationId: launchOrigin.organizationId },
      },
      select: { id: true },
    })
    if (!launchTeam) {
      return null
    }
  }

  const target = await resolveExecutionTarget(prisma, agentId, {
    targetChannelId: input.targetChannelId,
    targetThreadId: input.targetThreadId,
  })
  if (!target) {
    return null
  }

  const trigger = await prisma.agentTrigger.create({
    data: {
      agentId,
      type: input.type,
      enabled: input.enabled ?? true,
      status: input.enabled === false ? 'paused' : 'active',
      name: input.name,
      description: input.description,
      config: normalizedConfig as Prisma.InputJsonValue,
      nextRunAt: normalizedNextRunAt ?? undefined,
      targetChannelId: target.channelId,
      targetThreadId: target.threadId,
    },
  })

  return mapTriggerRecord(trigger)
}
