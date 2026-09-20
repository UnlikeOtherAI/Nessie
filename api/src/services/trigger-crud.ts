import type { PrismaClient } from '@prisma/client'
import {
  buildAgentVisibilityWhere,
  createAgentTrigger,
  createWorkflowTrigger,
  deleteAgentTrigger,
  getAgentTrigger,
  listAgentTriggers,
  updateAgentTrigger,
  type AgentTriggerScope,
  agentTriggerScopeWhere,
} from '@nessie/team-admin'
import type {
  AgentTriggerDeliveryRecord,
  AgentTriggerRecord,
  AgentTriggerType,
} from '../contracts/triggers.js'
import {
  mapTriggerDeliveryRecord,
  mapTriggerRecord,
  normalizeNextRunAt,
  SCHEDULER_TRIGGER_TYPES,
  TRIGGER_ADMIN_AUDIENCE,
} from './trigger-shared.js'

// Trigger creation is shared with the worker (the assistant's
// `agent_trigger_create` tool); the route keeps importing it from here.
export { createAgentTrigger }
export { deleteAgentTrigger, getAgentTrigger, listAgentTriggers, updateAgentTrigger }
export type { AgentTriggerScope }

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
    where: agentTriggerScopeWhere(scope),
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
    where: { trigger: agentTriggerScopeWhere(scope) },
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
