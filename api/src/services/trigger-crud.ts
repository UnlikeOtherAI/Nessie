import { Prisma, type PrismaClient } from '@prisma/client'
import { parseIntervalMinutes, parseScheduledCronConfig } from '@nessie/runtime'
import {
  ScheduledTriggerLaunchOriginSchema,
  type ScheduledTriggerLaunchOrigin,
} from '@nessie/schemas'
import type {
  AgentTriggerDeliveryRecord,
  AgentTriggerRecord,
  AgentTriggerStatus,
  AgentTriggerType,
} from '../contracts.js'
import {
  ensureWebhookConfig,
  extractWebhookApiKey,
  isJsonRecord,
  mapTriggerDeliveryRecord,
  mapTriggerRecord,
  normalizeNextRunAt,
  resolveExecutionTarget,
  SCHEDULER_TRIGGER_TYPES,
  type WorkflowTriggerPrismaLike,
} from './trigger-shared.js'
import {
  mergeTriggerConfigPreservingIdentity,
  stripServerOwnedTriggerConfig,
} from './trigger-config-identity.js'

export const listAgentTriggers = async (
  prisma: PrismaClient,
  agentId: string,
): Promise<AgentTriggerRecord[]> => {
  const triggers = await prisma.agentTrigger.findMany({
    where: { agentId },
    orderBy: [{ createdAt: 'asc' }],
  })

  return triggers.map(mapTriggerRecord)
}

export const listOrganizationTriggers = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<AgentTriggerRecord[]> => {
  const triggers = await prisma.agentTrigger.findMany({
    where: {
      OR: [
        {
          agent: {
            agentKind: { in: ['shared', 'personal_assistant'] },
            OR: [
              { organizationId },
              {
                bindings: {
                  some: {
                    channel: { organizationId },
                  },
                },
              },
            ],
          },
        },
        {
          workflowInstallation: {
            organizationId,
          },
        },
      ],
    },
    orderBy: [{ createdAt: 'desc' }],
  })

  return triggers.map(mapTriggerRecord)
}

export const listWorkflowInstallationTriggers = async (
  prisma: PrismaClient,
  workflowInstallationId: string,
): Promise<AgentTriggerRecord[]> => {
  const triggers = await prisma.agentTrigger.findMany({
    where: { workflowInstallationId },
    orderBy: [{ createdAt: 'asc' }],
  })

  return triggers.map(mapTriggerRecord)
}

export const listScheduledTriggers = async (
  prisma: PrismaClient,
  input: {
    dueBefore?: Date
    limit: number
    organizationId: string
  },
): Promise<AgentTriggerRecord[]> => {
  const triggers = await prisma.agentTrigger.findMany({
    where: {
      OR: [
        {
          agent: {
            organizationId: input.organizationId,
            agentKind: { in: ['shared', 'personal_assistant'] },
          },
        },
        { workflowInstallation: { organizationId: input.organizationId } },
      ],
      enabled: true,
      status: 'active',
      type: {
        in: ['scheduled', 'interval'],
      },
      ...(input.dueBefore
        ? {
            nextRunAt: {
              lte: input.dueBefore,
            },
          }
        : {
            nextRunAt: {
              not: null,
            },
          }),
    },
    orderBy: [{ nextRunAt: 'asc' }, { createdAt: 'asc' }],
    take: input.limit,
  })

  return triggers.map(mapTriggerRecord)
}

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

export const createWorkflowTrigger = async (
  prisma: WorkflowTriggerPrismaLike,
  workflowInstallationId: string,
  input: {
    config?: Record<string, unknown>
    description?: string
    enabled?: boolean
    name?: string
    nextRunAt?: string
    type: AgentTriggerType
  },
): Promise<AgentTriggerRecord | null> => {
  const clientConfig = stripServerOwnedTriggerConfig(input.config)
  const normalizedConfig = input.type === 'webhook'
    ? ensureWebhookConfig(clientConfig)
    : clientConfig

  const normalizedNextRunAt = normalizeNextRunAt({
    config: normalizedConfig,
    nextRunAt: input.nextRunAt,
    type: input.type,
  })
  if (SCHEDULER_TRIGGER_TYPES.includes(input.type) && !normalizedNextRunAt) {
    return null
  }

  const installation = await prisma.workflowInstallation.findUnique({
    where: { id: workflowInstallationId },
    select: { id: true },
  })
  if (!installation) {
    return null
  }

  const trigger = await prisma.agentTrigger.create({
    data: {
      workflowInstallationId,
      type: input.type,
      enabled: input.enabled ?? true,
      status: input.enabled === false ? 'paused' : 'active',
      name: input.name,
      description: input.description,
      config: normalizedConfig as Prisma.InputJsonValue,
      nextRunAt: normalizedNextRunAt ?? undefined,
    },
  })

  return mapTriggerRecord(trigger)
}

export const getAgentTrigger = async (
  prisma: PrismaClient,
  triggerId: string,
): Promise<AgentTriggerRecord | null> => {
  const trigger = await prisma.agentTrigger.findUnique({
    where: { id: triggerId },
  })

  return trigger ? mapTriggerRecord(trigger) : null
}

export const updateAgentTrigger = async (
  prisma: PrismaClient,
  triggerId: string,
  input: {
    config?: Record<string, unknown>
    description?: string | null
    enabled?: boolean
    name?: string | null
    nextRunAt?: string | null
    status?: AgentTriggerStatus
    targetChannelId?: string | null
    targetThreadId?: string | null
  },
): Promise<AgentTriggerRecord | null> => {
  const existing = await prisma.agentTrigger.findUnique({
    where: { id: triggerId },
    select: {
      agentId: true,
      config: true,
      id: true,
      targetChannelId: true,
      targetThreadId: true,
      type: true,
      workflowInstallationId: true,
    },
  })

  if (!existing) {
    return null
  }

  const shouldUpdateTarget =
    input.targetChannelId !== undefined || input.targetThreadId !== undefined

  let target: { channelId: string | null; threadId: string | null }
  if (existing.agentId) {
    const resolved = shouldUpdateTarget
      ? await resolveExecutionTarget(prisma, existing.agentId, {
          targetChannelId:
            input.targetChannelId === undefined ? existing.targetChannelId : input.targetChannelId,
          targetThreadId:
            input.targetThreadId === undefined ? existing.targetThreadId : input.targetThreadId,
        })
      : {
          channelId: existing.targetChannelId,
          threadId: existing.targetThreadId,
        }
    if (!resolved?.channelId || !resolved.threadId) {
      return null
    }
    target = resolved
  } else {
    if (shouldUpdateTarget) {
      return null
    }
    target = { channelId: null, threadId: null }
  }

  const nextStatus =
    input.status ??
    (input.enabled === undefined ? undefined : input.enabled ? 'active' : 'paused')
  const nextConfig =
    input.config === undefined
      ? existing.config
      : mergeTriggerConfigPreservingIdentity(existing.config, input.config)
  const normalizedConfig =
    existing.type === 'webhook' ? ensureWebhookConfig(nextConfig) : nextConfig
  const shouldPersistConfig =
    existing.type === 'webhook'
      ? input.config !== undefined || !extractWebhookApiKey(existing.config)
      : input.config !== undefined
  const shouldRecomputeSchedulerNextRun =
    input.nextRunAt === undefined && input.config !== undefined
  const normalizedNextRunAt =
    existing.type === 'scheduled' || existing.type === 'interval'
      ? input.nextRunAt === undefined
        ? shouldRecomputeSchedulerNextRun
          ? normalizeNextRunAt({
              config: isJsonRecord(normalizedConfig) ? normalizedConfig : undefined,
              type: existing.type,
            })
          : undefined
        : input.nextRunAt === null
          ? null
          : normalizeNextRunAt({
              config: isJsonRecord(normalizedConfig) ? normalizedConfig : undefined,
              nextRunAt: input.nextRunAt,
              type: existing.type,
            })
      : input.nextRunAt === undefined
        ? undefined
        : input.nextRunAt === null
          ? null
          : new Date(input.nextRunAt)

  if (
    existing.type === 'scheduled' &&
    input.config !== undefined &&
    !parseScheduledCronConfig(normalizedConfig)
  ) {
    return null
  }

  if (
    existing.type === 'interval' &&
    input.config !== undefined &&
    !parseIntervalMinutes(normalizedConfig)
  ) {
    return null
  }

  const trigger = await prisma.agentTrigger.update({
    where: { id: triggerId },
    data: {
      name: input.name === undefined ? undefined : input.name,
      description: input.description === undefined ? undefined : input.description,
      enabled: input.enabled,
      status: nextStatus,
      config: shouldPersistConfig
        ? (normalizedConfig as Prisma.InputJsonValue)
        : undefined,
      ...(shouldUpdateTarget
        ? {
            targetChannelId: target.channelId,
            targetThreadId: target.threadId,
          }
        : {}),
      nextRunAt: normalizedNextRunAt,
    },
  })

  return mapTriggerRecord(trigger)
}

export const deleteAgentTrigger = async (
  prisma: PrismaClient,
  triggerId: string,
): Promise<boolean> => {
  const deliveryCount = await prisma.agentTriggerDelivery.count({
    where: { triggerId },
  })
  if (deliveryCount > 0) {
    return false
  }

  const result = await prisma.agentTrigger.deleteMany({
    where: { id: triggerId },
  })

  return result.count > 0
}

export const pauseAgentTrigger = async (
  prisma: PrismaClient,
  triggerId: string,
): Promise<AgentTriggerRecord | null> =>
  updateAgentTrigger(prisma, triggerId, {
    enabled: false,
    status: 'paused',
  })

export const resumeAgentTrigger = async (
  prisma: PrismaClient,
  triggerId: string,
): Promise<AgentTriggerRecord | null> =>
  updateAgentTrigger(prisma, triggerId, {
    enabled: true,
    status: 'active',
  })

export const listAgentTriggerDeliveries = async (
  prisma: PrismaClient,
  triggerId: string,
  limit: number,
): Promise<AgentTriggerDeliveryRecord[]> => {
  const deliveries = await prisma.agentTriggerDelivery.findMany({
    where: { triggerId },
    include: {
      run: {
        select: { id: true },
      },
    },
    orderBy: [{ createdAt: 'desc' }],
    take: limit,
  })

  return deliveries.map(mapTriggerDeliveryRecord)
}
