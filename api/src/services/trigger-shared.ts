import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import {
  MAX_DELIVERY_RETRIES,
  computeNextCronRunAt,
  computeNextRetryAt,
  parseIntervalMinutes,
} from '@nessie/runtime'
import {
  parseAgentId,
  parseChannelId,
  parseRunId,
  parseThreadId,
} from '@nessie/schemas'
import type {
  AgentTriggerDeliveryRecord,
  AgentTriggerRecord,
  AgentTriggerType,
} from '../contracts.js'
import { ensureDefaultThread } from './channel-records.js'

// Shared internals for the trigger service: record mappers, config validators,
// schedule/target resolution, and delivery-dedupe helpers used by both the CRUD
// surface (trigger-crud.ts) and the dispatch surface (trigger-dispatch*.ts).

export const SCHEDULER_TRIGGER_TYPES: AgentTriggerType[] = ['scheduled', 'interval']
export type WorkflowTriggerPrismaLike = Pick<
  PrismaClient,
  'agentTrigger' | 'workflowInstallation'
>

export const toTimestamp = (value: Date | null | undefined): string | undefined =>
  value ? value.toISOString() : undefined

export const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const generateWebhookApiKey = (): string =>
  `ntk_${randomUUID().replace(/-/g, '')}`

export const extractWebhookApiKey = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const apiKey = (value as Record<string, unknown>)['apiKey']
  return typeof apiKey === 'string' && apiKey.trim().length > 0 ? apiKey : undefined
}

export const ensureWebhookConfig = (value: unknown): Record<string, unknown> => {
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

export const mapTriggerRecord = (trigger: {
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

export const mapTriggerDeliveryRecord = (delivery: {
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

export const normalizeNextRunAt = (input: {
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

export const resolveExecutionTarget = async (
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

export const normalizePayload = (payload: unknown): Prisma.InputJsonValue => {
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

// sp-webhook: persist a retryable `failed` delivery after a dispatch failure so
// the worker retry poller can re-attempt with backoff. Mirrors the worker's
// recordDeliveryFailure; both share the backoff policy from @nessie/runtime.
export const recordTriggerDeliveryFailure = async (
  prisma: PrismaClient,
  input: {
    dedupeKey?: string
    error: unknown
    payload: Prisma.InputJsonValue
    source: string
    triggerId: string
  },
): Promise<void> => {
  const errorMessage = input.error instanceof Error ? input.error.message : String(input.error)
  const nextRetryAt = computeNextRetryAt(0)
  const retryCount = Math.min(1, MAX_DELIVERY_RETRIES)

  if (input.dedupeKey) {
    await prisma.agentTriggerDelivery.upsert({
      where: {
        triggerId_dedupeKey: {
          triggerId: input.triggerId,
          dedupeKey: input.dedupeKey,
        },
      },
      create: {
        triggerId: input.triggerId,
        dedupeKey: input.dedupeKey,
        payload: input.payload,
        source: input.source,
        status: 'failed',
        errorMessage,
        retryCount,
        nextRetryAt,
      },
      update: {
        status: 'failed',
        errorMessage,
        retryCount,
        nextRetryAt,
      },
    })
    return
  }

  await prisma.agentTriggerDelivery.create({
    data: {
      triggerId: input.triggerId,
      payload: input.payload,
      source: input.source,
      status: 'failed',
      errorMessage,
      retryCount,
      nextRetryAt,
    },
  })
}

export const isTriggerDeliveryDedupeConflict = (
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

export const loadExistingDeliveryRun = async (
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
  // A `delivered` delivery with no run is a fire that PENDED on a busy
  // (agent, thread) slot: it is already dispatched (the batched follow-up run
  // attaches it on drain), so dedupe must treat it as existing — re-firing
  // would double-deliver, and falling through would mis-mark it `failed`.
  if (!runId && !workflowRunId && existingDelivery.status !== 'delivered') {
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
