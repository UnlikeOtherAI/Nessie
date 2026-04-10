import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { CronExpressionParser } from 'cron-parser'
import {
  type AgentTriggerType,
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseRunId,
  parseTaskId,
  parseTeamId,
  parseThreadId,
  type AuthorizedActionContext,
  type TriggerEventDispatchJobPayload,
} from '@nessie/schemas'
import { enqueueRunExecution } from '../queue.js'

const DEFAULT_SCHEDULER_LEASE_MS = 60_000
const DEFAULT_SCHEDULER_RETRY_DELAY_MS = 60_000

type ClaimedScheduledTrigger = {
  agentId: string
  config: unknown
  id: string
  nextRunAt: Date
  schedulerClaimId: string
  targetChannelId: string | null
  targetThreadId: string | null
  type: AgentTriggerType
}

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

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

const buildTriggerPrompt = (input: {
  payload: unknown
  source: string
  triggerType: AgentTriggerType
}): string => {
  const prefix = `A ${input.triggerType} trigger fired from ${input.source}.`
  if (input.payload === undefined) {
    return `${prefix}\n\nNo payload was provided.`
  }

  return `${prefix}\n\nPayload:\n${JSON.stringify(input.payload, null, 2)}`
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

const buildActorContext = (input: {
  agentId: string
  channelId: string
  organizationId: string
  projectId?: string | null
  teamId?: string | null
  threadId: string
  taskId: string
  source: string
}): AuthorizedActionContext => ({
  actor: {
    actorId: input.agentId,
    actorType: 'agent',
    roles: ['system'],
  },
  actionContext: {
    agentId: parseAgentId(input.agentId),
    channelId: parseChannelId(input.channelId),
    purpose: input.source,
    requestId: randomUUID(),
    threadId: parseThreadId(input.threadId),
    taskId: parseTaskId(input.taskId),
  },
  tenant: {
    organizationId: parseOrganizationId(input.organizationId),
    projectId: input.projectId ? parseProjectId(input.projectId) : undefined,
    teamId: input.teamId ? parseTeamId(input.teamId) : undefined,
  },
})

const queueTriggerRun = async (
  prisma: PrismaClient,
  input: {
    dedupeKey?: string
    payload: unknown
    source: string
    trigger: {
      agent: {
        organizationId: string | null
        projectId: string | null
        teamId: string | null
      }
      agentId: string
      id: string
      targetChannelId: string
      targetThreadId: string
      type: AgentTriggerType
    }
  },
): Promise<void> => {
  const existingDelivery = input.dedupeKey
    ? await prisma.agentTriggerDelivery.findFirst({
        where: {
          dedupeKey: input.dedupeKey,
          triggerId: input.trigger.id,
        },
        include: {
          run: {
            select: { id: true },
          },
        },
      })
    : null

  if (existingDelivery?.run?.id) {
    return
  }

  const thread = await prisma.thread.findUnique({
    where: { id: input.trigger.targetThreadId },
    select: {
      channel: {
        select: { organizationId: true },
      },
      channelId: true,
    },
  })
  if (!thread || thread.channelId !== input.trigger.targetChannelId) {
    return
  }

  const binding = await prisma.agentBinding.findFirst({
    where: {
      agentId: input.trigger.agentId,
      channelId: input.trigger.targetChannelId,
    },
    select: { id: true },
  })
  if (!binding) {
    return
  }

  const content = buildTriggerPrompt({
    payload: input.payload,
    source: input.source,
    triggerType: input.trigger.type,
  })

  try {
    await prisma.$transaction(async (tx) => {
      const delivery = await tx.agentTriggerDelivery.create({
        data: {
          dedupeKey: input.dedupeKey,
          payload: normalizePayload(input.payload),
          source: input.source,
          status: 'pending',
          triggerId: input.trigger.id,
        },
      })

      const message = await tx.message.create({
        data: {
          content,
          role: 'user',
          threadId: input.trigger.targetThreadId,
        },
        select: { id: true },
      })

      const run = await tx.run.create({
        data: {
          agentId: input.trigger.agentId,
          status: 'pending',
          threadId: input.trigger.targetThreadId,
          triggerDeliveryId: delivery.id,
          triggerId: input.trigger.id,
        },
        select: { id: true },
      })

      const task = await tx.task.create({
        data: {
          agentId: input.trigger.agentId,
          purpose: content.slice(0, 200),
          runId: run.id,
          status: 'inbox',
        },
        select: { id: true },
      })

      await enqueueRunExecution(
        tx,
        {
          actorContext: buildActorContext({
            agentId: input.trigger.agentId,
            channelId: input.trigger.targetChannelId,
            organizationId:
              input.trigger.agent.organizationId ?? thread.channel.organizationId,
            projectId: input.trigger.agent.projectId,
            source: input.source,
            taskId: task.id,
            teamId: input.trigger.agent.teamId,
            threadId: input.trigger.targetThreadId,
          }),
          agentId: parseAgentId(input.trigger.agentId),
          messageId: message.id,
          runId: parseRunId(run.id),
          taskId: parseTaskId(task.id),
          threadId: parseThreadId(input.trigger.targetThreadId),
        },
        `run:${run.id}`,
      )

      await tx.agentTriggerDelivery.update({
        where: { id: delivery.id },
        data: {
          deliveredAt: new Date(),
          status: 'delivered',
        },
      })

      await tx.agentTrigger.update({
        where: { id: input.trigger.id },
        data: {
          lastFiredAt: new Date(),
        },
      })
    })
  } catch (error) {
    if (
      input.dedupeKey &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return
    }
    throw error
  }
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
        at."agent_id" AS "agentId",
        at."config",
        at."id",
        at."next_run_at" AS "nextRunAt",
        at."scheduler_claim_id" AS "schedulerClaimId",
        at."target_channel_id" AS "targetChannelId",
        at."target_thread_id" AS "targetThreadId",
        at."type"
    `,
  )
}

const finalizeScheduledTriggerClaim = async (
  prisma: PrismaClient,
  input: {
    claimId: string
    nextRunAt: Date | null
    status?: 'active' | 'error'
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
    limit: number
    now?: Date
  },
): Promise<void> => {
  const now = input.now ?? new Date()
  const claimedTriggers = await claimDueScheduledTriggers(prisma, input)

  for (const trigger of claimedTriggers) {
    if (!trigger.targetChannelId || !trigger.targetThreadId) {
      await finalizeScheduledTriggerClaim(prisma, {
        claimId: trigger.schedulerClaimId,
        nextRunAt: trigger.nextRunAt,
        status: 'error',
        triggerId: trigger.id,
      })
      continue
    }

    const triggerWithAgent = await prisma.agentTrigger.findUnique({
      where: { id: trigger.id },
      select: {
        agent: {
          select: {
            organizationId: true,
            projectId: true,
            teamId: true,
          },
        },
        agentId: true,
        id: true,
        targetChannelId: true,
        targetThreadId: true,
        type: true,
      },
    })

    if (!triggerWithAgent?.targetChannelId || !triggerWithAgent.targetThreadId) {
      await finalizeScheduledTriggerClaim(prisma, {
        claimId: trigger.schedulerClaimId,
        nextRunAt: trigger.nextRunAt,
        status: 'error',
        triggerId: trigger.id,
      })
      continue
    }

    try {
      const targetChannelId = triggerWithAgent.targetChannelId
      const targetThreadId = triggerWithAgent.targetThreadId

      await queueTriggerRun(prisma, {
        dedupeKey: `scheduled:${trigger.id}:${trigger.nextRunAt.toISOString()}`,
        payload: {
          scheduledFor: trigger.nextRunAt.toISOString(),
          triggerId: trigger.id,
        },
        source: 'scheduler',
        trigger: {
          ...triggerWithAgent,
          targetChannelId,
          targetThreadId,
        },
      })

      await finalizeScheduledTriggerClaim(prisma, {
        claimId: trigger.schedulerClaimId,
        nextRunAt: buildNextScheduledRunAt({
          config: trigger.config,
          from: trigger.nextRunAt,
          now,
          type: trigger.type,
        }),
        status: 'active',
        triggerId: trigger.id,
      })
    } catch {
      await finalizeScheduledTriggerClaim(prisma, {
        claimId: trigger.schedulerClaimId,
        nextRunAt: new Date(now.getTime() + DEFAULT_SCHEDULER_RETRY_DELAY_MS),
        triggerId: trigger.id,
      })
    }
  }
}

export const dispatchEventTriggers = async (
  prisma: PrismaClient,
  input: TriggerEventDispatchJobPayload,
): Promise<void> => {
  const triggers = await prisma.agentTrigger.findMany({
    where: {
      enabled: true,
      status: 'active',
      type: 'event',
    },
      select: {
      agent: {
        select: {
          organizationId: true,
          projectId: true,
          teamId: true,
        },
      },
      agentId: true,
      config: true,
      id: true,
      targetChannelId: true,
      targetThreadId: true,
      type: true,
    },
  })

  for (const trigger of triggers) {
    if (!trigger.targetChannelId || !trigger.targetThreadId) {
      continue
    }
    if (!matchesEventTriggerConfig(trigger.config, input.eventType, input.payload)) {
      continue
    }

    const targetChannelId = trigger.targetChannelId
    const targetThreadId = trigger.targetThreadId

    await queueTriggerRun(prisma, {
      dedupeKey: input.dedupeKey
        ? `event:${trigger.id}:${input.dedupeKey}`
        : undefined,
      payload: {
        eventType: input.eventType,
        ...input.payload,
      },
      source: input.source,
      trigger: {
        ...trigger,
        targetChannelId,
        targetThreadId,
      },
    })
  }
}
