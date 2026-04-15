import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { CronExpressionParser } from 'cron-parser'
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
  type WorkflowRunExecuteJobPayload,
} from '@nessie/schemas'
import type {
  AgentTriggerDeliveryRecord,
  AgentTriggerRecord,
  AgentTriggerStatus,
  AgentTriggerType,
} from '../contracts.js'
import { enqueueQueueJob, enqueueRunExecution } from '../queue/pgqueue.js'
import { ensureDefaultThread } from './channels.js'

const SCHEDULER_TRIGGER_TYPES: AgentTriggerType[] = ['scheduled', 'interval']

const toTimestamp = (value: Date | null | undefined): string | undefined =>
  value ? value.toISOString() : undefined

const generateWebhookApiKey = (): string =>
  `ntk_${randomUUID().replace(/-/g, '')}`

const extractWebhookApiKey = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const apiKey = (value as Record<string, unknown>)['apiKey']
  return typeof apiKey === 'string' && apiKey.trim().length > 0 ? apiKey : undefined
}

const ensureWebhookConfig = (
  value: unknown,
): Record<string, unknown> => {
  const config = isJsonRecord(value) ? { ...value } : {}
  return {
    ...config,
    apiKey: extractWebhookApiKey(config) ?? generateWebhookApiKey(),
  }
}

const redactTriggerConfig = (value: unknown): Record<string, unknown> => {
  const config =
    value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {}

  if ('secret' in config) {
    config['secret'] = '[redacted]'
  }
  if ('apiKey' in config) {
    config['apiKey'] = '[redacted]'
  }

  return config
}

const mapTriggerRecord = (trigger: {
  agentId: string | null
  config: unknown
  createdAt: Date
  description: string | null
  enabled: boolean
  id: string
  lastFiredAt: Date | null
  name: string | null
  nextRunAt: Date | null
  status: 'active' | 'paused' | 'error'
  targetChannelId: string | null
  targetThreadId: string | null
  type: 'manual' | 'scheduled' | 'webhook' | 'event' | 'interval'
  updatedAt: Date
  workflowInstallationId: string | null
}): AgentTriggerRecord => ({
  id: trigger.id,
  agentId: trigger.agentId ? parseAgentId(trigger.agentId) : undefined,
  workflowInstallationId: trigger.workflowInstallationId ?? undefined,
  type: trigger.type,
  status: trigger.status,
  enabled: trigger.enabled,
  name: trigger.name ?? undefined,
  description: trigger.description ?? undefined,
  config: redactTriggerConfig(trigger.config),
  webhookApiKey: extractWebhookApiKey(trigger.config),
  targetChannelId: trigger.targetChannelId ? parseChannelId(trigger.targetChannelId) : undefined,
  targetThreadId: trigger.targetThreadId ? parseThreadId(trigger.targetThreadId) : undefined,
  lastFiredAt: toTimestamp(trigger.lastFiredAt),
  nextRunAt: toTimestamp(trigger.nextRunAt),
  createdAt: trigger.createdAt.toISOString(),
  updatedAt: trigger.updatedAt.toISOString(),
})

const mapTriggerDeliveryRecord = (delivery: {
  createdAt: Date
  dedupeKey: string | null
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
  dedupeKey: delivery.dedupeKey ?? undefined,
  status: delivery.status,
  source: delivery.source ?? undefined,
  payload: delivery.payload,
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

export const listOrganizationTriggers = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<AgentTriggerRecord[]> => {
  const triggers = await prisma.agentTrigger.findMany({
    where: {
      OR: [
        {
          agent: {
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
        { agent: { organizationId: input.organizationId } },
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
): Promise<AgentTriggerRecord | null> => {
  const normalizedConfig = input.type === 'webhook'
    ? ensureWebhookConfig(input.config)
    : (input.config ?? {})

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
    select: { id: true },
  })

  if (!agent) {
    return null
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
  prisma: PrismaClient,
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
  const normalizedConfig = input.type === 'webhook'
    ? ensureWebhookConfig(input.config)
    : (input.config ?? {})

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
      : {
          ...(isJsonRecord(existing.config) ? existing.config : {}),
          ...input.config,
        }
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

const normalizePayload = (payload: unknown): Prisma.InputJsonValue => {
  if (payload === null) {
    return Prisma.JsonNull as unknown as Prisma.InputJsonValue
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

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parsePositiveInteger = (value: unknown): number | null => {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isInteger(value)
  ) {
    return null
  }

  return value
}

const parseScheduledCronConfig = (
  config: unknown,
): { cron: string; timezone?: string } | null => {
  if (!isJsonRecord(config)) {
    return null
  }

  const cron = config['cron']
  if (typeof cron !== 'string' || cron.trim().length === 0) {
    return null
  }

  const timezone =
    typeof config['timezone'] === 'string' && config['timezone'].trim().length > 0
      ? config['timezone']
      : undefined

  try {
    CronExpressionParser.parse(cron, {
      currentDate: new Date(),
      ...(timezone ? { tz: timezone } : {}),
    })
  } catch {
    return null
  }

  return { cron, timezone }
}

const parseIntervalMinutes = (config: unknown): number | null => {
  if (!isJsonRecord(config)) {
    return null
  }

  return parsePositiveInteger(config['interval_minutes'])
}

const computeNextCronRunAt = (input: {
  config: unknown
  currentDate: Date
}): Date | null => {
  const scheduled = parseScheduledCronConfig(input.config)
  if (!scheduled) {
    return null
  }

  try {
    return CronExpressionParser.parse(scheduled.cron, {
      currentDate: input.currentDate,
      ...(scheduled.timezone ? { tz: scheduled.timezone } : {}),
    })
      .next()
      .toDate()
  } catch {
    return null
  }
}

const normalizeNextRunAt = (input: {
  config?: Record<string, unknown>
  nextRunAt?: string
  type: AgentTriggerType
}): Date | undefined | null => {
  if (!SCHEDULER_TRIGGER_TYPES.includes(input.type)) {
    return input.nextRunAt ? new Date(input.nextRunAt) : undefined
  }

  if (input.type === 'scheduled') {
    if (input.nextRunAt) {
      return new Date(input.nextRunAt)
    }

    return computeNextCronRunAt({
      config: input.config,
      currentDate: new Date(),
    })
  }

  const intervalMinutes = parseIntervalMinutes(input.config)
  if (!intervalMinutes) {
    return null
  }

  return input.nextRunAt
    ? new Date(input.nextRunAt)
    : new Date(Date.now() + intervalMinutes * 60_000)
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

const resolveExecutionTarget = async (
  prisma: PrismaClient,
  agentId: string,
  input: {
    targetChannelId?: string | null
    targetThreadId?: string | null
  },
): Promise<{ channelId: string; threadId: string } | null> => {
  const targetThreadId = input.targetThreadId ?? undefined
  const targetChannelId = input.targetChannelId ?? undefined

  if (!targetThreadId && !targetChannelId) {
    return null
  }

  if (targetThreadId) {
    const thread = await prisma.thread.findUnique({
      where: { id: targetThreadId },
      select: {
        channelId: true,
      },
    })
    if (!thread) {
      return null
    }

    if (targetChannelId && thread.channelId !== targetChannelId) {
      return null
    }

    const binding = await prisma.agentBinding.findFirst({
      where: {
        agentId,
        channelId: thread.channelId,
      },
      select: { id: true },
    })
    if (!binding) {
      return null
    }

    return {
      channelId: thread.channelId,
      threadId: targetThreadId,
    }
  }

  if (!targetChannelId) {
    return null
  }

  const binding = await prisma.agentBinding.findFirst({
    where: {
      agentId,
      channelId: targetChannelId,
    },
    select: { id: true },
  })
  if (!binding) {
    return null
  }

  return {
    channelId: targetChannelId,
    threadId: await ensureDefaultThread(prisma, targetChannelId),
  }
}

const isTriggerDeliveryDedupeConflict = (
  error: Prisma.PrismaClientKnownRequestError,
): boolean => {
  if (error.code !== 'P2002') {
    return false
  }

  const target = error.meta?.target
  if (!Array.isArray(target)) {
    return false
  }

  return target.includes('trigger_id') && target.includes('dedupe_key')
}

const loadExistingDeliveryRun = async (
  prisma: PrismaClient,
  input: { dedupeKey: string; triggerId: string },
): Promise<
  | null
  | {
      delivery: Parameters<typeof mapTriggerDeliveryRecord>[0]
      runId?: string
      workflowRunId?: string
    }
> => {
  const existingDelivery = await prisma.agentTriggerDelivery.findFirst({
    where: {
      dedupeKey: input.dedupeKey,
      triggerId: input.triggerId,
    },
    include: {
      run: {
        select: { id: true },
      },
      workflowRuns: {
        select: { id: true },
        take: 1,
      },
    },
  })

  if (!existingDelivery) {
    return null
  }

  const runId = existingDelivery.run?.id
  const workflowRunId = existingDelivery.workflowRuns[0]?.id
  if (!runId && !workflowRunId) {
    return null
  }

  return {
    delivery: existingDelivery,
    runId,
    workflowRunId,
  }
}

export type DispatchTriggerResult =
  | {
      kind: 'rejected'
      reason:
        | 'agent_not_bound'
        | 'trigger_not_found'
        | 'trigger_paused'
        | 'workflow_installation_not_ready'
        | 'webhook_secret_mismatch'
    }
  | {
      delivery: AgentTriggerDeliveryRecord
      existing: boolean
      kind: 'queued'
      runId?: ReturnType<typeof parseRunId>
      trigger: AgentTriggerRecord
      workflowRunId?: string
    }

export const dispatchAgentTrigger = async (
  prisma: PrismaClient,
  input: {
    actorContext?: AuthorizedActionContext
    dedupeKey?: string
    payload?: unknown
    prompt?: string
    source: string
    triggerId: string
  },
): Promise<DispatchTriggerResult> => {
  const loadTrigger = () =>
    prisma.agentTrigger.findUnique({
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

  const trigger = await loadTrigger()

  if (!trigger) {
    return { kind: 'rejected', reason: 'trigger_not_found' }
  }

  if (!trigger.enabled || trigger.status !== 'active') {
    return { kind: 'rejected', reason: 'trigger_paused' }
  }

  if (trigger.workflowInstallationId) {
    return dispatchWorkflowTrigger(prisma, {
      actorContext: input.actorContext,
      dedupeKey: input.dedupeKey,
      loadTrigger,
      payload: input.payload,
      prompt: input.prompt,
      source: input.source,
      trigger,
    })
  }

  if (!trigger.agentId || !trigger.agent) {
    return { kind: 'rejected', reason: 'agent_not_bound' }
  }
  const agentId = trigger.agentId
  const agent = trigger.agent

  if (!trigger.targetChannelId || !trigger.targetThreadId) {
    return { kind: 'rejected', reason: 'agent_not_bound' }
  }

  const thread = await prisma.thread.findUnique({
    where: { id: trigger.targetThreadId },
    select: {
      channelId: true,
      channel: {
        select: {
          organizationId: true,
        },
      },
      id: true,
    },
  })
  if (!thread) {
    return { kind: 'rejected', reason: 'agent_not_bound' }
  }
  if (thread.channelId !== trigger.targetChannelId) {
    return { kind: 'rejected', reason: 'agent_not_bound' }
  }

  const binding = await prisma.agentBinding.findFirst({
    where: {
      agentId,
      channelId: trigger.targetChannelId,
    },
    select: { id: true },
  })
  if (!binding) {
    return { kind: 'rejected', reason: 'agent_not_bound' }
  }

  const threadTarget = {
    channelId: trigger.targetChannelId,
    organizationId: thread.channel.organizationId,
    threadId: trigger.targetThreadId,
  }

  if (input.dedupeKey) {
    const existing = await loadExistingDeliveryRun(prisma, {
      dedupeKey: input.dedupeKey,
      triggerId: input.triggerId,
    })

    if (existing?.runId) {
      return {
        kind: 'queued',
        delivery: mapTriggerDeliveryRecord({
          ...existing.delivery,
          run: existing.delivery.run,
        }),
        existing: true,
        runId: parseRunId(existing.runId),
        trigger: mapTriggerRecord(trigger),
      }
    }
  }

  const actorContext =
    input.actorContext ??
    ({
      actor: {
        actorId: agentId,
        actorType: 'agent',
        roles: ['system'],
      },
      actionContext: {
        agentId: parseAgentId(agentId),
        channelId: parseChannelId(threadTarget.channelId),
        requestId: randomUUID(),
        sessionId: undefined,
        threadId: parseThreadId(threadTarget.threadId),
      },
      tenant: {
        organizationId: parseOrganizationId(
          agent.organizationId ?? threadTarget.organizationId,
        ),
        projectId: agent.projectId ? parseProjectId(agent.projectId) : undefined,
        teamId: agent.teamId ? parseTeamId(agent.teamId) : undefined,
      },
    })

  const normalizedPayload = normalizePayload(input.payload)
  const content = buildTriggerPrompt({
    payload: input.payload,
    prompt: input.prompt,
    source: input.source,
    triggerType: trigger.type,
  })

  try {
    const result = await prisma.$transaction(async (tx) => {
      const delivery = await tx.agentTriggerDelivery.create({
        data: {
          payload: normalizedPayload,
          dedupeKey: input.dedupeKey,
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
          role: 'user',
          threadId: threadTarget.threadId,
        },
      })

      const run = await tx.run.create({
        data: {
          agentId,
          status: 'pending',
          threadId: threadTarget.threadId,
          triggerId: trigger.id,
          triggerDeliveryId: delivery.id,
        },
      })

      const task = await tx.task.create({
        data: {
          agentId,
          purpose: content.slice(0, 200),
          runId: run.id,
          status: 'inbox',
        },
      })

      const queuePayload = {
        actorContext: {
          ...actorContext,
          actionContext: {
            ...actorContext.actionContext,
            agentId: parseAgentId(agentId),
            channelId: parseChannelId(threadTarget.channelId),
            taskId: parseTaskId(task.id),
            threadId: parseThreadId(threadTarget.threadId),
          },
        },
        agentId: parseAgentId(agentId),
        messageId: message.id,
        runId: parseRunId(run.id),
        taskId: parseTaskId(task.id),
        threadId: parseThreadId(threadTarget.threadId),
      }

      await enqueueRunExecution(tx, queuePayload, `run:${run.id}`)

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

      return { completedDelivery, run }
    })

    return {
      kind: 'queued',
      delivery: mapTriggerDeliveryRecord(result.completedDelivery),
      existing: false,
      runId: parseRunId(result.run.id),
      trigger: mapTriggerRecord(trigger),
    }
  } catch (error) {
    if (
      input.dedupeKey &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      isTriggerDeliveryDedupeConflict(error)
    ) {
      const existing = await loadExistingDeliveryRun(prisma, {
        dedupeKey: input.dedupeKey,
        triggerId: input.triggerId,
      })

      if (existing?.runId) {
        const latestTrigger = await loadTrigger()
        if (!latestTrigger) {
          return { kind: 'rejected', reason: 'trigger_not_found' }
        }

        return {
          kind: 'queued',
          delivery: mapTriggerDeliveryRecord({
            ...existing.delivery,
            run: existing.delivery.run,
          }),
          existing: true,
          runId: parseRunId(existing.runId),
          trigger: mapTriggerRecord(latestTrigger),
        }
      }
    }

    throw error
  }
}

const dispatchWorkflowTrigger = async (
  prisma: PrismaClient,
  input: {
    actorContext?: AuthorizedActionContext
    dedupeKey?: string
    loadTrigger: () => Promise<
      Awaited<ReturnType<PrismaClient['agentTrigger']['findUnique']>>
    >
    payload?: unknown
    prompt?: string
    source: string
    trigger: {
      id: string
      type: 'manual' | 'scheduled' | 'webhook' | 'event' | 'interval'
      workflowInstallation: {
        active: boolean
        channelId: string | null
        id: string
        organizationId: string
        projectId: string | null
        status: 'active' | 'disabled' | 'draft' | 'paused'
        teamId: string | null
      } | null
    } & Parameters<typeof mapTriggerRecord>[0]
  },
): Promise<DispatchTriggerResult> => {
  const installation = input.trigger.workflowInstallation
  if (!installation || !installation.active || installation.status === 'disabled') {
    return { kind: 'rejected', reason: 'workflow_installation_not_ready' }
  }

  if (input.dedupeKey) {
    const existing = await loadExistingDeliveryRun(prisma, {
      dedupeKey: input.dedupeKey,
      triggerId: input.trigger.id,
    })
    if (existing?.workflowRunId) {
      return {
        kind: 'queued',
        delivery: mapTriggerDeliveryRecord({
          ...existing.delivery,
          run: existing.delivery.run,
        }),
        existing: true,
        trigger: mapTriggerRecord(input.trigger),
        workflowRunId: existing.workflowRunId,
      }
    }
  }

  const actorContext =
    input.actorContext ??
    ({
      actor: {
        actorId: installation.id,
        actorType: 'service',
        roles: ['system'],
      },
      actionContext: {
        ...(installation.channelId
          ? { channelId: parseChannelId(installation.channelId) }
          : {}),
        purpose: `trigger:${input.trigger.type}`,
        requestId: randomUUID(),
        sessionId: undefined,
      },
      tenant: {
        organizationId: parseOrganizationId(installation.organizationId),
        projectId: installation.projectId ? parseProjectId(installation.projectId) : undefined,
        teamId: installation.teamId ? parseTeamId(installation.teamId) : undefined,
      },
    })

  const normalizedPayload = normalizePayload(input.payload)

  try {
    const result = await prisma.$transaction(async (tx) => {
      const delivery = await tx.agentTriggerDelivery.create({
        data: {
          payload: normalizedPayload,
          dedupeKey: input.dedupeKey,
          source: input.source,
          status: 'pending',
          triggerId: input.trigger.id,
        },
        include: {
          run: {
            select: { id: true },
          },
        },
      })

      const workflowRun = await tx.workflowRun.create({
        data: {
          installationId: installation.id,
          organizationId: installation.organizationId,
          triggerId: input.trigger.id,
          triggerDeliveryId: delivery.id,
          input: (input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
            ? (input.payload as Record<string, unknown>)
            : { payload: input.payload ?? null }) as Prisma.InputJsonValue,
          startedByActorType: actorContext.actor.actorType,
          startedByActorId: actorContext.actor.actorId,
        },
      })

      const jobPayload: WorkflowRunExecuteJobPayload = {
        actorContext,
        workflowRunId: workflowRun.id,
      }
      await enqueueQueueJob(tx, {
        idempotencyKey: `workflow-run:start:${workflowRun.id}`,
        payload: jobPayload,
        topic: 'workflow.run.execute',
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
        where: { id: input.trigger.id },
        data: {
          lastFiredAt: new Date(),
        },
      })

      return { completedDelivery, workflowRun }
    })

    return {
      kind: 'queued',
      delivery: mapTriggerDeliveryRecord(result.completedDelivery),
      existing: false,
      trigger: mapTriggerRecord(input.trigger),
      workflowRunId: result.workflowRun.id,
    }
  } catch (error) {
    if (
      input.dedupeKey &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      isTriggerDeliveryDedupeConflict(error)
    ) {
      const existing = await loadExistingDeliveryRun(prisma, {
        dedupeKey: input.dedupeKey,
        triggerId: input.trigger.id,
      })
      if (existing?.workflowRunId) {
        const latestTrigger = await input.loadTrigger()
        if (!latestTrigger) {
          return { kind: 'rejected', reason: 'trigger_not_found' }
        }
        return {
          kind: 'queued',
          delivery: mapTriggerDeliveryRecord({
            ...existing.delivery,
            run: existing.delivery.run,
          }),
          existing: true,
          trigger: mapTriggerRecord(latestTrigger),
          workflowRunId: existing.workflowRunId,
        }
      }
    }

    throw error
  }
}
