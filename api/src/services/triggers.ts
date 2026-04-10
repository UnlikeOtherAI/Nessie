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
} from '@nessie/schemas'
import type {
  AgentTriggerDeliveryRecord,
  AgentTriggerRecord,
  AgentTriggerStatus,
  AgentTriggerType,
} from '../contracts.js'
import { enqueueRunExecution } from '../queue/pgqueue.js'
import { ensureDefaultThread } from './channels.js'

const DEFAULT_SCHEDULER_LEASE_MS = 60_000
const DEFAULT_SCHEDULER_RETRY_DELAY_MS = 30_000
const SCHEDULER_TRIGGER_TYPES: AgentTriggerType[] = ['scheduled', 'interval']

const toTimestamp = (value: Date | null | undefined): string | undefined =>
  value ? value.toISOString() : undefined

const redactTriggerConfig = (value: unknown): Record<string, unknown> => {
  const config =
    value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {}

  if ('secret' in config) {
    config['secret'] = '[redacted]'
  }

  return config
}

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
  targetChannelId: string | null
  targetThreadId: string | null
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
  config: redactTriggerConfig(trigger.config),
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
    orderBy: [{ createdAt: 'desc' }],
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
      agent: {
        organizationId: input.organizationId,
      },
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
  if (input.type === 'webhook' && typeof input.config?.['secret'] !== 'string') {
    return null
  }

  const normalizedNextRunAt = normalizeNextRunAt({
    config: input.config,
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
      config: (input.config ?? {}) as Prisma.InputJsonValue,
      nextRunAt: normalizedNextRunAt ?? undefined,
      targetChannelId: target.channelId,
      targetThreadId: target.threadId,
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
    },
  })

  if (!existing) {
    return null
  }

  if (existing.type === 'webhook' && input.config) {
    const nextConfig = {
      ...(existing.config && typeof existing.config === 'object' && !Array.isArray(existing.config)
        ? (existing.config as Record<string, unknown>)
        : {}),
      ...input.config,
    }

    if (typeof nextConfig['secret'] !== 'string') {
      return null
    }
  }

  const shouldUpdateTarget =
    input.targetChannelId !== undefined || input.targetThreadId !== undefined

  const target = shouldUpdateTarget
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

  if (!target?.channelId || !target.threadId) {
    return null
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
  const shouldRecomputeSchedulerNextRun =
    input.nextRunAt === undefined && input.config !== undefined
  const normalizedNextRunAt =
    existing.type === 'scheduled' || existing.type === 'interval'
      ? input.nextRunAt === undefined
        ? shouldRecomputeSchedulerNextRun
          ? normalizeNextRunAt({
              config: isJsonRecord(nextConfig) ? nextConfig : undefined,
              type: existing.type,
            })
          : undefined
        : input.nextRunAt === null
          ? null
          : normalizeNextRunAt({
              config: isJsonRecord(nextConfig) ? nextConfig : undefined,
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
    !parseScheduledCronConfig(nextConfig)
  ) {
    return null
  }

  if (
    existing.type === 'interval' &&
    input.config !== undefined &&
    !parseIntervalMinutes(nextConfig)
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
      config:
        input.config === undefined
          ? undefined
          : (nextConfig as Prisma.InputJsonValue),
      targetChannelId: target.channelId,
      targetThreadId: target.threadId,
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

const buildNextScheduledRunAt = (input: {
  config: unknown
  from: Date
  now: Date
  type: AgentTriggerType
}): Date | null => {
  if (input.type === 'scheduled') {
    return computeNextCronRunAt({
      config: input.config,
      currentDate: input.from,
    })
  }

  if (input.type !== 'interval') {
    return input.from
  }

  const intervalMinutes = parseIntervalMinutes(input.config)
  if (!intervalMinutes) {
    return null
  }

  const base = input.from.getTime() > input.now.getTime() ? input.from : input.now
  return new Date(base.getTime() + intervalMinutes * 60_000)
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

type ClaimedScheduledTrigger = {
  config: unknown
  id: string
  nextRunAt: Date
  schedulerClaimId: string
  type: AgentTriggerType
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

const claimDueScheduledTriggers = async (
  prisma: PrismaClient,
  input: {
    leaseMs?: number
    limit: number
    now?: Date
  },
): Promise<ClaimedScheduledTrigger[]> => {
  const now = input.now ?? new Date()
  const claimId = randomUUID()
  const leaseExpiry = new Date(now.getTime() - (input.leaseMs ?? DEFAULT_SCHEDULER_LEASE_MS))

  return prisma.$queryRaw<ClaimedScheduledTrigger[]>(
    Prisma.sql`
      WITH due AS (
        SELECT at.id
        FROM "agent_triggers" AS at
        WHERE at."enabled" = true
          AND at."status" = 'active'::"AgentTriggerStatus"
          AND at."type" IN ('scheduled'::"AgentTriggerType", 'interval'::"AgentTriggerType")
          AND at."next_run_at" IS NOT NULL
          AND at."next_run_at" <= ${now}
          AND (
            at."scheduler_claimed_at" IS NULL
            OR at."scheduler_claimed_at" < ${leaseExpiry}
          )
        ORDER BY at."next_run_at" ASC, at."created_at" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${input.limit}
      )
      UPDATE "agent_triggers" AS at
      SET
        "scheduler_claim_id" = ${claimId}::uuid,
        "scheduler_claimed_at" = ${now}
      FROM due
      WHERE at."id" = due."id"
      RETURNING
        at."id",
        at."config",
        at."next_run_at" AS "nextRunAt",
        at."scheduler_claim_id" AS "schedulerClaimId",
        at."type"
    `,
  )
}

const finalizeScheduledTriggerClaim = async (
  prisma: PrismaClient,
  input: {
    claimId: string
    nextRunAt: Date | null
    status?: AgentTriggerStatus
    triggerId: string
  },
): Promise<void> => {
  await prisma.$executeRaw(
    Prisma.sql`
      UPDATE "agent_triggers"
      SET
        "next_run_at" = ${input.nextRunAt},
        "scheduler_claim_id" = NULL,
        "scheduler_claimed_at" = NULL,
        "status" = COALESCE(${input.status}::"AgentTriggerStatus", "status")
      WHERE "id" = ${input.triggerId}::uuid
        AND "scheduler_claim_id" = ${input.claimId}::uuid
    `,
  )
}

export const sweepDueScheduledTriggers = async (
  prisma: PrismaClient,
  input: {
    leaseMs?: number
    limit: number
    now?: Date
  },
): Promise<{ claimed: number; dispatched: number; failed: number }> => {
  const now = input.now ?? new Date()
  const claimedTriggers = await claimDueScheduledTriggers(prisma, input)
  let dispatched = 0
  let failed = 0

  for (const trigger of claimedTriggers) {
    const dedupeKey = `scheduled:${trigger.id}:${trigger.nextRunAt.toISOString()}`

    try {
      const result = await dispatchAgentTrigger(prisma, {
        dedupeKey,
        payload: {
          scheduledFor: trigger.nextRunAt.toISOString(),
          triggerId: trigger.id,
        },
        source: 'scheduler',
        triggerId: trigger.id,
      })

      if (result.kind === 'queued') {
        const nextRunAt = buildNextScheduledRunAt({
          config: trigger.config,
          from: trigger.nextRunAt,
          now,
          type: trigger.type,
        })
        await finalizeScheduledTriggerClaim(prisma, {
          claimId: trigger.schedulerClaimId,
          nextRunAt,
          status: !nextRunAt ? 'error' : 'active',
          triggerId: trigger.id,
        })
        dispatched += 1
        continue
      }

      await finalizeScheduledTriggerClaim(prisma, {
        claimId: trigger.schedulerClaimId,
        nextRunAt:
          result.reason === 'agent_not_bound'
            ? trigger.nextRunAt
            : new Date(now.getTime() + DEFAULT_SCHEDULER_RETRY_DELAY_MS),
        status: result.reason === 'agent_not_bound' ? 'error' : 'active',
        triggerId: trigger.id,
      })
      failed += 1
    } catch {
      await finalizeScheduledTriggerClaim(prisma, {
        claimId: trigger.schedulerClaimId,
        nextRunAt: new Date(now.getTime() + DEFAULT_SCHEDULER_RETRY_DELAY_MS),
        triggerId: trigger.id,
      })
      failed += 1
    }
  }

  return {
    claimed: claimedTriggers.length,
    dispatched,
    failed,
  }
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
): Promise<
  | {
      reason: 'agent_not_bound' | 'trigger_not_found' | 'trigger_paused' | 'webhook_secret_mismatch'
      kind: 'rejected'
    }
  | {
      delivery: AgentTriggerDeliveryRecord
      existing: boolean
      kind: 'queued'
      runId: ReturnType<typeof parseRunId>
      trigger: AgentTriggerRecord
    }
> => {
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
      },
    })

  const trigger = await loadTrigger()

  if (!trigger) {
    return { kind: 'rejected', reason: 'trigger_not_found' }
  }

  if (!trigger.enabled || trigger.status !== 'active') {
    return { kind: 'rejected', reason: 'trigger_paused' }
  }

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
      agentId: trigger.agentId,
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
    const existingDelivery = await prisma.agentTriggerDelivery.findFirst({
      where: {
        dedupeKey: input.dedupeKey,
        triggerId: input.triggerId,
      },
      include: {
        run: {
          select: { id: true },
        },
      },
    })

    if (existingDelivery?.run?.id) {
      return {
        kind: 'queued',
        delivery: mapTriggerDeliveryRecord(existingDelivery),
        existing: true,
        runId: parseRunId(existingDelivery.run.id),
        trigger: mapTriggerRecord(trigger),
      }
    }
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

      const queuePayload = {
        actorContext: {
          ...actorContext,
          actionContext: {
            ...actorContext.actionContext,
            agentId: parseAgentId(trigger.agentId),
            channelId: parseChannelId(threadTarget.channelId),
            taskId: parseTaskId(task.id),
            threadId: parseThreadId(threadTarget.threadId),
          },
        },
        agentId: parseAgentId(trigger.agentId),
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
      const existingDelivery = await prisma.agentTriggerDelivery.findFirst({
        where: {
          dedupeKey: input.dedupeKey,
          triggerId: input.triggerId,
        },
        include: {
          run: {
            select: { id: true },
          },
        },
      })

      if (existingDelivery?.run?.id) {
        const latestTrigger = await loadTrigger()
        if (!latestTrigger) {
          return { kind: 'rejected', reason: 'trigger_not_found' }
        }

        return {
          kind: 'queued',
          delivery: mapTriggerDeliveryRecord(existingDelivery),
          existing: true,
          runId: parseRunId(existingDelivery.run.id),
          trigger: mapTriggerRecord(latestTrigger),
        }
      }
    }

    throw error
  }
}

export const dispatchEventTriggers = async (
  prisma: PrismaClient,
  input: {
    actorContext?: AuthorizedActionContext
    eventType: string
    payload: Record<string, unknown>
    source: string
  },
): Promise<
  Array<{
    delivery: AgentTriggerDeliveryRecord
    existing: boolean
    runId: ReturnType<typeof parseRunId>
    trigger: AgentTriggerRecord
  }>
> => {
  const triggers = await prisma.agentTrigger.findMany({
    where: {
      enabled: true,
      status: 'active',
      type: 'event',
    },
  })

  const matches = triggers.filter((trigger) =>
    matchesEventTriggerConfig(trigger.config, input.eventType, input.payload),
  )

  const results = await Promise.all(
    matches.map(async (trigger) => {
      const dispatched = await dispatchAgentTrigger(prisma, {
        actorContext: input.actorContext,
        dedupeKey: `${input.eventType}:${trigger.id}:${JSON.stringify(input.payload)}`,
        payload: {
          eventType: input.eventType,
          ...input.payload,
        },
        source: input.source,
        triggerId: trigger.id,
      })

      return dispatched.kind === 'queued'
        ? {
            delivery: dispatched.delivery,
            existing: dispatched.existing,
            runId: dispatched.runId,
            trigger: dispatched.trigger,
          }
        : null
    }),
  )

  return results.filter((result): result is NonNullable<typeof result> => result !== null)
}
