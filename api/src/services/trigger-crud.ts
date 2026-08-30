import { Prisma, type PrismaClient } from '@prisma/client'
import { parseIntervalMinutes, parseScheduledCronConfig } from '@nessie/runtime'
import {
  createAgentTrigger,
  mergeTriggerConfigPreservingIdentity,
  stripServerOwnedTriggerConfig,
} from '@nessie/workspace-admin'
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
  TRIGGER_ADMIN_AUDIENCE,
  type WorkflowTriggerPrismaLike,
} from './trigger-shared.js'

// Trigger creation is shared with the worker (the assistant's
// `agent_trigger_create` tool); the route keeps importing it from here.
export { createAgentTrigger }

export const listAgentTriggers = async (
  prisma: PrismaClient,
  agentId: string,
): Promise<AgentTriggerRecord[]> => {
  const triggers = await prisma.agentTrigger.findMany({
    where: { agentId },
    orderBy: [{ createdAt: 'asc' }],
  })

  return triggers.map((trigger) => mapTriggerRecord(trigger, TRIGGER_ADMIN_AUDIENCE))
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

  return triggers.map((trigger) => mapTriggerRecord(trigger, TRIGGER_ADMIN_AUDIENCE))
}

export const listWorkflowInstallationTriggers = async (
  prisma: PrismaClient,
  workflowInstallationId: string,
): Promise<AgentTriggerRecord[]> => {
  const triggers = await prisma.agentTrigger.findMany({
    where: { workflowInstallationId },
    orderBy: [{ createdAt: 'asc' }],
  })

  // Deliberately NOT the admin audience: this route gates on
  // `canActorReadWorkflowInstallation` (entitlement to read the installation),
  // not on org ownership, so it is reachable by members who may not hold the
  // webhook intake credential. The key is revealed at creation instead.
  return triggers.map((trigger) => mapTriggerRecord(trigger))
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

  return triggers.map((trigger) => mapTriggerRecord(trigger, TRIGGER_ADMIN_AUDIENCE))
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

  return mapTriggerRecord(trigger, TRIGGER_ADMIN_AUDIENCE)
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

  return mapTriggerRecord(trigger, TRIGGER_ADMIN_AUDIENCE)
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

/**
 * Resume a paused trigger.
 *
 * A schedule can be paused two ways: by a person, which leaves `next_run_at`
 * intact, or by reaching its `config.until`, which cleared it. Flipping status
 * alone would revive the second kind as `active` with no next run — enabled to
 * look at, silently dead forever — so a scheduler-type trigger with no armed
 * next run is re-armed here. If its end is still in the past there is nothing
 * to arm and it stays paused, which is the honest answer: extend the end first.
 */
export const resumeAgentTrigger = async (
  prisma: PrismaClient,
  triggerId: string,
): Promise<AgentTriggerRecord | null> => {
  const existing = await prisma.agentTrigger.findUnique({
    select: { config: true, nextRunAt: true, type: true },
    where: { id: triggerId },
  })
  if (!existing) return null

  const needsRearm =
    existing.nextRunAt === null
    && SCHEDULER_TRIGGER_TYPES.includes(existing.type as AgentTriggerType)
  const rearmed = needsRearm
    ? normalizeNextRunAt({
        config: (existing.config ?? {}) as Record<string, unknown>,
        type: existing.type as AgentTriggerType,
      })
    : undefined

  if (needsRearm && !rearmed) {
    return mapTriggerRecord(
      await prisma.agentTrigger.findUniqueOrThrow({ where: { id: triggerId } }),
      TRIGGER_ADMIN_AUDIENCE,
    )
  }

  return updateAgentTrigger(prisma, triggerId, {
    enabled: true,
    status: 'active',
    ...(rearmed ? { nextRunAt: rearmed.toISOString() } : {}),
  })
}

export const listAgentTriggerDeliveries = async (
  prisma: PrismaClient,
  triggerId: string,
  limit: number,
): Promise<AgentTriggerDeliveryRecord[]> => {
  const deliveries = await prisma.agentTriggerDelivery.findMany({
    where: { triggerId },
    include: {
      run: {
        select: { id: true, status: true },
      },
    },
    orderBy: [{ createdAt: 'desc' }],
    take: limit,
  })

  return deliveries.map(mapTriggerDeliveryRecord)
}
