import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseRunId,
  parseTaskId,
  parseTeamId,
  parseThreadId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import type {
  AgentTriggerDeliveryRecord,
  AgentTriggerRecord,
  AgentTriggerStatus,
  AgentTriggerType,
} from '../contracts.js'
import { ensureDefaultThread } from './channels.js'

const toTimestamp = (value: Date | null | undefined): string | undefined =>
  value ? value.toISOString() : undefined

const toRecordObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const mapTriggerRecord = (trigger: {
  agentId: string
  config: unknown
  createdAt: Date
  description: string | null
  enabled: boolean
  id: string
  lastFiredAt: Date | null
  name: string | null
  nextRunAt: Date | null
  status: 'active' | 'paused' | 'error'
  type: 'manual' | 'scheduled' | 'webhook' | 'event' | 'interval'
  updatedAt: Date
}): AgentTriggerRecord => ({
  id: trigger.id,
  agentId: parseAgentId(trigger.agentId),
  type: trigger.type,
  status: trigger.status,
  enabled: trigger.enabled,
  name: trigger.name ?? undefined,
  description: trigger.description ?? undefined,
  config: toRecordObject(trigger.config),
  lastFiredAt: toTimestamp(trigger.lastFiredAt),
  nextRunAt: toTimestamp(trigger.nextRunAt),
  createdAt: trigger.createdAt.toISOString(),
  updatedAt: trigger.updatedAt.toISOString(),
})

const mapTriggerDeliveryRecord = (delivery: {
  createdAt: Date
  deliveredAt: Date | null
  errorMessage: string | null
  id: string
  payload: unknown
  run: { id: string } | null
  source: string | null
  status: 'pending' | 'delivered' | 'failed' | 'skipped'
  triggerId: string
}): AgentTriggerDeliveryRecord => ({
  id: delivery.id,
  triggerId: delivery.triggerId,
  status: delivery.status,
  source: delivery.source ?? undefined,
  payload: toRecordObject(delivery.payload),
  errorMessage: delivery.errorMessage ?? undefined,
  runId: delivery.run ? parseRunId(delivery.run.id) : undefined,
  deliveredAt: toTimestamp(delivery.deliveredAt),
  createdAt: delivery.createdAt.toISOString(),
})

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

export const createAgentTrigger = async (
  prisma: PrismaClient,
  agentId: string,
  input: {
    config?: Record<string, unknown>
    description?: string
    enabled?: boolean
    name?: string
    nextRunAt?: string
    type: AgentTriggerType
  },
): Promise<AgentTriggerRecord | null> => {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true },
  })

  if (!agent) {
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
      config: (input.config ?? {}) as Prisma.InputJsonValue,
      nextRunAt: input.nextRunAt ? new Date(input.nextRunAt) : undefined,
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
  },
): Promise<AgentTriggerRecord | null> => {
  const existing = await prisma.agentTrigger.findUnique({
    where: { id: triggerId },
    select: { id: true },
  })

  if (!existing) {
    return null
  }

  const nextStatus =
    input.status ??
    (input.enabled === undefined ? undefined : input.enabled ? 'active' : 'paused')

  const trigger = await prisma.agentTrigger.update({
    where: { id: triggerId },
    data: {
      name: input.name === undefined ? undefined : input.name,
      description: input.description === undefined ? undefined : input.description,
      enabled: input.enabled,
      status: nextStatus,
      config: input.config as Prisma.InputJsonValue | undefined,
      nextRunAt:
        input.nextRunAt === undefined
          ? undefined
          : input.nextRunAt === null
            ? null
            : new Date(input.nextRunAt),
    },
  })

  return mapTriggerRecord(trigger)
}

export const deleteAgentTrigger = async (
  prisma: PrismaClient,
  triggerId: string,
): Promise<boolean> => {
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

const normalizePayload = (
  payload: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull => {
  if (payload === null) {
    return Prisma.JsonNull
  }

  if (
    typeof payload === 'string' ||
    typeof payload === 'number' ||
    typeof payload === 'boolean'
  ) {
    return payload
  }

  if (Array.isArray(payload)) {
    return payload as Prisma.InputJsonValue
  }

  if (payload && typeof payload === 'object') {
    return payload as Prisma.InputJsonValue
  }

  return {}
}

const buildTriggerPrompt = (input: {
  payload: unknown
  prompt?: string
  source: string
  triggerType: AgentTriggerType
}): string => {
  const explicitPrompt = input.prompt?.trim()
  if (explicitPrompt) {
    return explicitPrompt
  }

  const prefix = `A ${input.triggerType} trigger fired from ${input.source}.`
  if (input.payload === undefined) {
    return `${prefix}\n\nNo payload was provided.`
  }

  const serializedPayload = JSON.stringify(input.payload, null, 2)
  return `${prefix}\n\nPayload:\n${serializedPayload}`
}

const resolveTriggerThread = async (
  prisma: PrismaClient,
  agentId: string,
): Promise<{ channelId: string; organizationId: string; threadId: string } | null> => {
  const binding = await prisma.agentBinding.findFirst({
    where: { agentId },
    orderBy: { createdAt: 'asc' },
    include: {
      channel: {
        select: {
          id: true,
          organizationId: true,
        },
      },
    },
  })

  if (!binding) {
    return null
  }

  return {
    channelId: binding.channel.id,
    organizationId: binding.channel.organizationId,
    threadId: await ensureDefaultThread(prisma, binding.channel.id),
  }
}

export const dispatchAgentTrigger = async (
  prisma: PrismaClient,
  input: {
    actorContext?: AuthorizedActionContext
    payload?: unknown
    prompt?: string
    source: string
    triggerId: string
  },
): Promise<
  | {
      reason: 'agent_not_bound' | 'trigger_not_found' | 'trigger_paused' | 'webhook_secret_mismatch'
      kind: 'rejected'
    }
  | {
      delivery: AgentTriggerDeliveryRecord
      kind: 'queued'
      queuePayload: {
        actorContext: AuthorizedActionContext
        agentId: ReturnType<typeof parseAgentId>
        messageId: string
        runId: ReturnType<typeof parseRunId>
        taskId: ReturnType<typeof parseTaskId>
        threadId: ReturnType<typeof parseThreadId>
      }
      trigger: AgentTriggerRecord
    }
> => {
  const trigger = await prisma.agentTrigger.findUnique({
    where: { id: input.triggerId },
    include: {
      agent: {
        select: {
          id: true,
          organizationId: true,
          projectId: true,
          teamId: true,
        },
      },
    },
  })

  if (!trigger) {
    return { kind: 'rejected', reason: 'trigger_not_found' }
  }

  if (!trigger.enabled || trigger.status !== 'active') {
    return { kind: 'rejected', reason: 'trigger_paused' }
  }

  const threadTarget = await resolveTriggerThread(prisma, trigger.agentId)
  if (!threadTarget) {
    return { kind: 'rejected', reason: 'agent_not_bound' }
  }

  const actorContext =
    input.actorContext ??
    ({
      actor: {
        actorId: trigger.agentId,
        actorType: 'agent',
        roles: ['system'],
      },
      actionContext: {
        agentId: parseAgentId(trigger.agentId),
        channelId: parseChannelId(threadTarget.channelId),
        requestId: randomUUID(),
        sessionId: undefined,
        threadId: parseThreadId(threadTarget.threadId),
      },
      tenant: {
        organizationId: parseOrganizationId(
          trigger.agent.organizationId ?? threadTarget.organizationId,
        ),
        projectId: trigger.agent.projectId ? parseProjectId(trigger.agent.projectId) : undefined,
        teamId: trigger.agent.teamId ? parseTeamId(trigger.agent.teamId) : undefined,
      },
    })

  const normalizedPayload = normalizePayload(input.payload)
  const content = buildTriggerPrompt({
    payload: input.payload,
    prompt: input.prompt,
    source: input.source,
    triggerType: trigger.type,
  })

  const result = await prisma.$transaction(async (tx) => {
    const delivery = await tx.agentTriggerDelivery.create({
      data: {
        payload: normalizedPayload,
        source: input.source,
        status: 'pending',
        triggerId: trigger.id,
      },
      include: {
        run: {
          select: { id: true },
        },
      },
    })

    const message = await tx.message.create({
      data: {
        content,
        role: 'system',
        threadId: threadTarget.threadId,
      },
    })

    const run = await tx.run.create({
      data: {
        agentId: trigger.agentId,
        status: 'pending',
        threadId: threadTarget.threadId,
        triggerId: trigger.id,
        triggerDeliveryId: delivery.id,
      },
    })

    const task = await tx.task.create({
      data: {
        agentId: trigger.agentId,
        purpose: content.slice(0, 200),
        runId: run.id,
        status: 'inbox',
      },
    })

    const completedDelivery = await tx.agentTriggerDelivery.update({
      where: { id: delivery.id },
      data: {
        deliveredAt: new Date(),
        status: 'delivered',
      },
      include: {
        run: {
          select: { id: true },
        },
      },
    })

    await tx.agentTrigger.update({
      where: { id: trigger.id },
      data: {
        lastFiredAt: new Date(),
      },
    })

    return { completedDelivery, message, run, task }
  })

  return {
    kind: 'queued',
    delivery: mapTriggerDeliveryRecord(result.completedDelivery),
    queuePayload: {
      actorContext: {
        ...actorContext,
        actionContext: {
          ...actorContext.actionContext,
          agentId: parseAgentId(trigger.agentId),
          channelId: parseChannelId(threadTarget.channelId),
          taskId: parseTaskId(result.task.id),
          threadId: parseThreadId(threadTarget.threadId),
        },
      },
      agentId: parseAgentId(trigger.agentId),
      messageId: result.message.id,
      runId: parseRunId(result.run.id),
      taskId: parseTaskId(result.task.id),
      threadId: parseThreadId(threadTarget.threadId),
    },
    trigger: mapTriggerRecord(trigger),
  }
}
