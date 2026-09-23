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
  TRIGGER_ADMIN_AUDIENCE,
} from './trigger-core.js'
import { stripServerOwnedTriggerConfig } from './trigger-config-identity.js'
import { resolveTicketChangedTrigger } from './trigger-ticket-config.js'
import { unreleasedTriggerTypeRefusal } from './trigger-type-availability.js'
import { acquireAgentTodoAgentLock } from './agent-todo-lock.js'

/**
 * The config JSON is otherwise open-ended. This named check is the one place
 * a `todoTemplateId` becomes a scheduled capability rather than inert data.
 */
export const validateTodoTemplateTriggerConfig = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  agentId: string,
  config: Record<string, unknown>,
): Promise<boolean> => {
  const todoTemplateId = config['todoTemplateId']
  if (todoTemplateId === undefined) return true
  if (typeof todoTemplateId !== 'string') return false
  const agent = await prisma.agent.findUnique({
    select: { organizationId: true, todosEnabled: true },
    where: { id: agentId },
  })
  if (!agent?.todosEnabled || !agent.organizationId) return false
  return Boolean(await prisma.agentTodoTemplate.findFirst({
    select: { id: true },
    where: {
      agentId,
      id: todoTemplateId,
      organizationId: agent.organizationId,
      status: 'active',
    },
  }))
}

type CreateAgentTriggerInput = {
  config?: Record<string, unknown>
  description?: string
  enabled?: boolean
  name?: string
  nextRunAt?: string
  targetChannelId?: string
  targetThreadId?: string
  type: AgentTriggerType
}

/**
 * Create a trigger on an agent. Shared by `POST /api/agents/:agentId/triggers`
 * and the personal assistant's `agent_trigger_create` tool: `launchOrigin` is a
 * trusted, caller-supplied argument in both, because only the surface holding a
 * live session can say which user and UOA team a future fire inherits.
 *
 * `authorUserId` is who set the trigger up, recorded for every type. It is
 * authorship only and grants nothing: no fire path reads it as the identity a
 * run acts as (docs/standards/ticket-work.md).
 *
 * A `ticket_changed` config is resolved and checked field by field
 * (`resolveTicketChangedTrigger`), and a refusal throws
 * `TriggerConfigRefusalError` naming each field. Every other type answers null
 * for anything it refuses, as it always has.
 */
export const createAgentTrigger = async (
  prisma: PrismaClient,
  agentId: string,
  input: CreateAgentTriggerInput,
  trusted: {
    authorUserId?: string
    launchOrigin?: ScheduledTriggerLaunchOrigin
  } = {},
): Promise<AgentTriggerRecord | null> => {
  // The surfaces refuse an unreleased type with its own sentence first; this
  // is the floor under them, before anything is read or written.
  if (unreleasedTriggerTypeRefusal(input.type)) return null
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
  const authorUserId = launchOrigin?.userId ?? trusted.authorUserId
  const authorship = authorUserId ? { authorUserId } : {}
  const normalizedConfig = input.type === 'webhook'
    ? { ...ensureWebhookConfig(clientConfig), ...authorship }
    : {
        ...clientConfig,
        ...authorship,
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
      name: true,
      organizationId: true,
      systemSlug: true,
    },
  })

  // v1 global agents own no automation. A scheduled run reconstructs its
  // creator's identity, which is exactly the identity a DM-homed global agent
  // delegates from — so an unattended fire would wield an absent person's
  // authority. Every blueprint declares `allowsSelfTriggers: false`; this is
  // that declaration enforced where triggers are actually written.
  if (!agent || agent.agentKind === 'personal_assistant' || agent.systemSlug) {
    return null
  }
  if (input.type === 'ticket_changed') {
    if (!agent.organizationId) return null
    return createTicketChangedTrigger(prisma, {
      agent: { id: agent.id, name: agent.name, organizationId: agent.organizationId },
      authorship,
      clientConfig,
      input,
    })
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

  const create = async (tx: Prisma.TransactionClient | PrismaClient) => {
    if (!await validateTodoTemplateTriggerConfig(tx, agentId, normalizedConfig)) {
      return null
    }
    const target = await resolveExecutionTarget(tx, agentId, {
      targetChannelId: input.targetChannelId,
      targetThreadId: input.targetThreadId,
    })
    if (!target) return null
    const trigger = await tx.agentTrigger.create({
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
    return mapTriggerRecord(trigger, TRIGGER_ADMIN_AUDIENCE)
  }

  if (!hasTodoTemplateReference(normalizedConfig)) return create(prisma)
  return prisma.$transaction(async (tx) => {
    await acquireAgentTodoAgentLock(tx, agentId)
    return create(tx)
  })
}

const hasTodoTemplateReference = (config: Record<string, unknown>): boolean =>
  Object.hasOwn(config, 'todoTemplateId')

/**
 * The `ticket_changed` create: resolved, checked and written in one
 * transaction, because the one-pickup-per-column check holds the board's lock
 * until the new row commits. The scope columns are the resolved project and
 * board, which is how the dispatcher finds the trigger.
 */
const createTicketChangedTrigger = async (
  prisma: PrismaClient,
  input: {
    agent: { id: string; name: string; organizationId: string }
    authorship: Record<string, unknown>
    clientConfig: Record<string, unknown>
    input: CreateAgentTriggerInput
  },
): Promise<AgentTriggerRecord | null> => prisma.$transaction(async (tx) => {
  const resolved = await resolveTicketChangedTrigger(tx, {
    agent: input.agent,
    config: input.clientConfig,
    enabled: input.input.enabled ?? true,
    nextRunAt: input.input.nextRunAt,
    targetChannelId: input.input.targetChannelId,
    targetThreadId: input.input.targetThreadId,
  })
  const target = await resolveExecutionTarget(tx, input.agent.id, { targetChannelId: resolved.targetChannelId })
  if (!target) return null
  const trigger = await tx.agentTrigger.create({
    data: {
      agentId: input.agent.id,
      type: 'ticket_changed',
      enabled: input.input.enabled ?? true,
      status: input.input.enabled === false ? 'paused' : 'active',
      name: input.input.name,
      description: input.input.description,
      config: { ...resolved.config, ...input.authorship } as Prisma.InputJsonValue,
      scopeBoardId: resolved.scopeBoardId,
      scopeProjectId: resolved.scopeProjectId,
      targetChannelId: target.channelId,
      targetThreadId: target.threadId,
    },
  })
  return mapTriggerRecord(trigger, TRIGGER_ADMIN_AUDIENCE)
})
