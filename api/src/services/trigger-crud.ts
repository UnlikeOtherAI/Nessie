import type { PrismaClient } from '@prisma/client'
import {
  extractTriggerEffectiveUserId,
  extractTriggerLaunchOrigin,
  isJsonRecord,
} from '@nessie/runtime'
import {
  acquireAgentTodoAgentLock,
  buildAgentVisibilityWhere,
  createAgentTrigger,
  createWorkflowTrigger,
  deleteAgentTrigger,
  endTicketWorkForTrigger,
  getAgentTrigger,
  listAgentTriggers,
  ticketTriggerPickupConflict,
  updateAgentTrigger,
  validateTodoTemplateTriggerConfig,
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
): Promise<AgentTriggerRecord | null> => {
  const paused = await prisma.$transaction(async (tx) => {
    // Keep a health diagnosis if it races this click. A read followed by the
    // shared update helper could read `active`, then overwrite a worker's
    // freshly-written `error` with `paused`, losing the only repair reason.
    // These conditional writes make whichever statement observes the health
    // state preserve it while still disabling the schedule.
    await tx.agentTrigger.updateMany({
      where: {
        ...agentTriggerScopeWhere(scope),
        status: { notIn: ['error', 'needs_reauthorization'] },
      },
      data: { enabled: false, status: 'paused' },
    })
    await tx.agentTrigger.updateMany({
      where: {
        ...agentTriggerScopeWhere(scope),
        status: { in: ['error', 'needs_reauthorization'] },
      },
      data: { enabled: false },
    })
    const trigger = await tx.agentTrigger.findFirst({ where: agentTriggerScopeWhere(scope) })
    // A paused ticket trigger ends the work it holds in the same write
    // (docs/standards/ticket-work.md); every other type holds none.
    if (trigger?.type === 'ticket_changed') await endTicketWorkForTrigger(tx, { triggerId: trigger.id })
    return trigger
  })
  return paused ? mapTriggerRecord(paused, TRIGGER_ADMIN_AUDIENCE) : null
}

export class TriggerResumeError extends Error {
  readonly code = 'TRIGGER_RESUME_BLOCKED'

  constructor(message: string) {
    super(message)
    this.name = 'TriggerResumeError'
  }
}

const assertTriggerCanResume = async (
  prisma: PrismaClient,
  input: {
    agent: {
      agentKind: 'personal_assistant' | 'shared'
      id: string
      organizationId: string | null
    } | null
    config: unknown
    healthReason: string | null
    organizationId: string
    targetChannelId: string | null
    targetThreadId: string | null
    type: AgentTriggerType
  },
): Promise<void> => {
  if (!input.agent || !input.targetChannelId || !input.targetThreadId) {
    throw new TriggerResumeError('Restore this schedule\'s agent and target before resuming it.')
  }
  const thread = await prisma.thread.findFirst({
    where: {
      id: input.targetThreadId,
      channelId: input.targetChannelId,
      channel: { deletedAt: null, organizationId: input.organizationId },
    },
    select: { id: true },
  })
  if (!thread) {
    throw new TriggerResumeError('Restore this schedule\'s target channel before resuming it.')
  }
  if (input.agent.agentKind !== 'personal_assistant') {
    const binding = await prisma.agentBinding.findFirst({
      where: { agentId: input.agent.id, channelId: input.targetChannelId },
      select: { id: true },
    })
    if (!binding) {
      throw new TriggerResumeError('Add the agent back to the target channel before resuming.')
    }
  }

  const config = isJsonRecord(input.config) ? input.config : null
  const hasSavedUser = config !== null && Object.hasOwn(config, 'createdByUserId')
  const hasLaunchOrigin = config !== null && Object.hasOwn(config, 'launchOrigin')
  const userId = extractTriggerEffectiveUserId(config)
  const origin = extractTriggerLaunchOrigin(config)
  if (!userId || !origin) {
    const schedulerRequiresOrigin =
      SCHEDULER_TRIGGER_TYPES.includes(input.type)
      && config?.['createdViaTool'] !== true
    if (
      hasSavedUser
      || hasLaunchOrigin
      || schedulerRequiresOrigin
      || input.healthReason === 'channel_access_lost'
    ) {
      throw new TriggerResumeError(
        'Repair this schedule\'s saved launch identity before resuming it.',
      )
    }
    return
  }
  if (
    origin.userId !== userId
    || origin.organizationId !== input.organizationId
    || (
      input.agent.organizationId !== null
      && origin.organizationId !== input.agent.organizationId
    )
  ) {
    throw new TriggerResumeError('Repair this schedule\'s saved launch identity before resuming it.')
  }

  const [channelMember, organizationMember, team] = await Promise.all([
    prisma.channelMember.findFirst({
      where: { channelId: input.targetChannelId, userId },
      select: { id: true },
    }),
    prisma.organizationMember.findFirst({
      where: {
        deactivatedAt: null,
        organizationId: input.organizationId,
        userId,
      },
      select: { id: true },
    }),
    origin.teamId
      ? prisma.team.findFirst({
          where: {
            id: origin.teamId,
            ...(origin.projectId ? { projectId: origin.projectId } : {}),
            members: { some: { userId } },
            project: { organizationId: input.organizationId },
          },
          select: { id: true },
        })
      : Promise.resolve({ id: 'no-team-required' }),
  ])
  if (!organizationMember) {
    throw new TriggerResumeError('Restore the person\'s organization access before resuming.')
  }
  if (!team) {
    throw new TriggerResumeError('Restore the person\'s team access before resuming.')
  }
  if (!channelMember) {
    throw new TriggerResumeError('Add the person back to the target channel before resuming.')
  }
}

/**
 * Resume a paused or repaired trigger from a fresh cadence.
 *
 * Error recovery first proves that the target, agent and saved human are live
 * again. Scheduler types always re-arm from now, then activation, health reset,
 * stale retry suppression and pending-run cancellation commit together. If an
 * ended schedule has no future occurrence it remains stopped until edited.
 */
export const resumeAgentTrigger = async (
  prisma: PrismaClient,
  scope: AgentTriggerScope,
): Promise<AgentTriggerRecord | null> => {
  const existing = await prisma.agentTrigger.findFirst({
    select: {
      agent: { select: { agentKind: true, id: true, organizationId: true } },
      config: true,
      enabled: true,
      healthReason: true,
      healthRevision: true,
      id: true,
      scopeBoardId: true,
      status: true,
      targetChannelId: true,
      targetThreadId: true,
      type: true,
    },
    where: agentTriggerScopeWhere(scope),
  })
  if (!existing) return null
  const triggerId = existing.id

  const needsRearm = SCHEDULER_TRIGGER_TYPES.includes(existing.type as AgentTriggerType)
  if (existing.status === 'error' || needsRearm) {
    await assertTriggerCanResume(prisma, {
      agent: existing.agent,
      config: existing.config,
      healthReason: existing.healthReason,
      organizationId: scope.organizationId,
      targetChannelId: existing.targetChannelId,
      targetThreadId: existing.targetThreadId,
      type: existing.type as AgentTriggerType,
    })
  }

  // Every scheduler resume starts from now. Keeping a stale occurrence makes a
  // repaired schedule replay missed intervals immediately and lets an old
  // failed delivery race the newly-active row.
  const configRecord = isJsonRecord(existing.config) ? existing.config : {}
  const rearmed = needsRearm
    ? normalizeNextRunAt({
        config: configRecord,
        type: existing.type as AgentTriggerType,
      })
    : undefined

  if (needsRearm && !rearmed) {
    return mapTriggerRecord(
      await prisma.agentTrigger.findUniqueOrThrow({ where: { id: triggerId } }),
      TRIGGER_ADMIN_AUDIENCE,
    )
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Switching a ticket trigger back on is when the one-pickup-per-column
    // rule can newly bite: another trigger may have claimed its column while
    // it was off. Checked under the board's lock, like a create or an edit.
    if (existing.type === 'ticket_changed') {
      const conflict = await ticketTriggerPickupConflict(tx, existing)
      if (conflict) {
        throw new TriggerResumeError(`${conflict[0]!.toUpperCase()}${conflict.slice(1)}.`)
      }
    }
    if (existing.agent && Object.hasOwn(configRecord, 'todoTemplateId')) {
      await acquireAgentTodoAgentLock(tx, existing.agent.id)
      if (!await validateTodoTemplateTriggerConfig(tx, existing.agent.id, configRecord)) {
        throw new TriggerResumeError(
          'Restore or replace this schedule\'s to-do template before resuming.',
        )
      }
    }
    const claimed = await tx.agentTrigger.updateMany({
      data: {
        enabled: true,
        healthDetail: null,
        healthReason: null,
        ...(needsRearm ? { nextRunAt: rearmed } : {}),
        schedulerClaimedAt: null,
        schedulerClaimId: null,
        status: 'active',
      },
      where: {
        id: triggerId,
        enabled: existing.enabled,
        healthRevision: existing.healthRevision,
        status: existing.status,
      },
    })
    if (claimed.count === 0) return null

    // The repair starts a new cadence. Old retries and trigger kickoffs must
    // not wake after the operator has explicitly resumed from a fresh point.
    await tx.agentTriggerDelivery.updateMany({
      where: { triggerId, status: 'failed' },
      data: { nextRetryAt: null },
    })
    await tx.task.updateMany({
      where: { run: { triggerId, status: 'pending' } },
      data: { status: 'cancelled' },
    })
    await tx.run.updateMany({
      where: { triggerId, status: 'pending' },
      data: { finishedAt: new Date(), status: 'cancelled' },
    })
    await tx.runThreadPendingMessage.deleteMany({ where: { triggerId } })

    return tx.agentTrigger.findUniqueOrThrow({ where: { id: triggerId } })
  })
  return updated ? mapTriggerRecord(updated, TRIGGER_ADMIN_AUDIENCE) : null
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
