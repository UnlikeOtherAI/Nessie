import { Prisma, type PrismaClient } from '@prisma/client'
import { parseIntervalMinutes, parseScheduledCronConfig } from '@nessie/runtime'
import {
  buildAgentVisibilityWhere,
  acquireAgentTodoAgentLock,
  createAgentTrigger,
  createWorkflowTrigger,
  mergeTriggerConfigPreservingIdentity,
  validateTodoTemplateTriggerConfig,
} from '@nessie/team-admin'
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
  userId: string,
): Promise<AgentTriggerRecord[]> => {
  const triggers = await prisma.agentTrigger.findMany({
    where: {
      OR: [
        {
          agent: {
            AND: [buildAgentVisibilityWhere({ organizationId, userId })],
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
    userId: string
  },
): Promise<AgentTriggerRecord[]> => {
  const triggers = await prisma.agentTrigger.findMany({
    where: {
      OR: [
        {
          agent: {
            AND: [buildAgentVisibilityWhere({
              organizationId: input.organizationId,
              userId: input.userId,
            })],
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

export { createWorkflowTrigger }

/**
 * Which trigger, in which tenant.
 *
 * `AgentTrigger` has no `organizationId` of its own: its only paths to a tenant
 * are the nullable `agentId` (through `Agent.organizationId`, or a channel the
 * agent is bound into) and the nullable `workflowInstallationId`, with a CHECK
 * guaranteeing exactly one is set. So every by-id read and write takes the
 * organisation and folds it into the `where`, the way the list functions above
 * already do — `schema.prisma`'s own house rule, "every by-id read still
 * filters on organizationId (never a bare findUnique on a caller-supplied id)".
 *
 * Before this, the authorisation predicate (the route's
 * `isTriggerAccessibleToActor`) and the mutation predicate (`findUnique({ id })`)
 * were two different queries against two different `where` clauses, and a
 * second caller — the worker, the PA, a new route — inherited nothing.
 */
export type AgentTriggerScope = {
  organizationId: string
  triggerId: string
}

const scopedTriggerWhere = (
  scope: AgentTriggerScope,
): Prisma.AgentTriggerWhereInput => ({
  id: scope.triggerId,
  OR: [
    {
      agent: {
        OR: [
          { organizationId: scope.organizationId },
          // A global agent carries no organizationId; it reaches a tenant
          // through the channels it is bound into. Same arm
          // `listOrganizationTriggers` uses, so the two cannot disagree.
          { bindings: { some: { channel: { organizationId: scope.organizationId } } } },
        ],
      },
    },
    { workflowInstallation: { organizationId: scope.organizationId } },
  ],
})

export const getAgentTrigger = async (
  prisma: PrismaClient,
  scope: AgentTriggerScope,
): Promise<AgentTriggerRecord | null> => {
  const trigger = await prisma.agentTrigger.findFirst({
    where: scopedTriggerWhere(scope),
  })

  return trigger ? mapTriggerRecord(trigger) : null
}

export const updateAgentTrigger = async (
  prisma: PrismaClient,
  scope: AgentTriggerScope,
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
  const existing = await prisma.agentTrigger.findFirst({
    where: scopedTriggerWhere(scope),
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
  const triggerId = existing.id

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

  const update = (tx: PrismaClient | Prisma.TransactionClient) => tx.agentTrigger.update({
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
  const config = isJsonRecord(normalizedConfig) ? normalizedConfig : {}
  const shouldValidateTodoTemplate = Object.hasOwn(config, 'todoTemplateId')
    && (input.config !== undefined || input.enabled === true)
  const trigger = shouldValidateTodoTemplate && existing.agentId
    ? await prisma.$transaction(async (tx) => {
        await acquireAgentTodoAgentLock(tx, existing.agentId!)
        if (!await validateTodoTemplateTriggerConfig(tx, existing.agentId!, config)) {
          return null
        }
        return update(tx)
      })
    : shouldValidateTodoTemplate
      ? null
    : await update(prisma)

  if (!trigger) return null

  return mapTriggerRecord(trigger, TRIGGER_ADMIN_AUDIENCE)
}

export const deleteAgentTrigger = async (
  prisma: PrismaClient,
  scope: AgentTriggerScope,
): Promise<boolean> => {
  const deliveryCount = await prisma.agentTriggerDelivery.count({
    where: { triggerId: scope.triggerId },
  })
  if (deliveryCount > 0) {
    return false
  }

  const result = await prisma.agentTrigger.deleteMany({
    where: scopedTriggerWhere(scope),
  })

  return result.count > 0
}

export const pauseAgentTrigger = async (
  prisma: PrismaClient,
  scope: AgentTriggerScope,
): Promise<AgentTriggerRecord | null> =>
  updateAgentTrigger(prisma, scope, {
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
  scope: AgentTriggerScope,
): Promise<AgentTriggerRecord | null> => {
  const existing = await prisma.agentTrigger.findFirst({
    select: { config: true, id: true, nextRunAt: true, type: true },
    where: scopedTriggerWhere(scope),
  })
  if (!existing) return null
  const triggerId = existing.id

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

  // Clear the stale verdict. Health records why the machine last refused to
  // run this schedule; resuming is the operator asserting they want it running
  // again, so carrying the old reason forward would leave the page explaining a
  // failure that is no longer current. The next fire re-derives it — and if the
  // cause is still there, that counts as a fresh transition and alerts again.
  await prisma.agentTrigger.update({
    data: { healthDetail: null, healthReason: null },
    where: { id: triggerId },
  })

  return updateAgentTrigger(prisma, scope, {
    enabled: true,
    status: 'active',
    ...(rearmed ? { nextRunAt: rearmed.toISOString() } : {}),
  })
}

export const listAgentTriggerDeliveries = async (
  prisma: PrismaClient,
  scope: AgentTriggerScope,
  limit: number,
): Promise<AgentTriggerDeliveryRecord[]> => {
  const deliveries = await prisma.agentTriggerDelivery.findMany({
    where: { trigger: scopedTriggerWhere(scope) },
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
