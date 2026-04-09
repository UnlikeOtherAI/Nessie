import type { Prisma, PrismaClient } from '@prisma/client'
import { parseAgentId, parseRunId } from '@nessie/schemas'
import type {
  AgentTriggerDeliveryRecord,
  AgentTriggerRecord,
  AgentTriggerStatus,
  AgentTriggerType,
} from '../contracts.js'

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
