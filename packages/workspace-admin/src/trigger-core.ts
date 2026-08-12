import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import {
  computeNextCronRunAt,
  parseIntervalMinutes,
  parseScheduleUntil,
} from '@nessie/runtime'
import {
  parseAgentId,
  parseChannelId,
  parseThreadId,
  type AgentTriggerRecord,
  type AgentTriggerType,
} from '@nessie/schemas'

import { ensureDefaultThread } from './channel-records.js'

// Trigger internals every writer needs: the record mapper, the webhook-key
// invariant, schedule arming, and target resolution. Shared with the worker so
// the personal assistant's `agent_trigger_create` arms a schedule exactly as
// the Triggers page does. Delivery/dispatch helpers stay in the API, which is
// where deliveries are created.

export const SCHEDULER_TRIGGER_TYPES: AgentTriggerType[] = ['scheduled', 'interval']

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

export const normalizeNextRunAt = (input: {
  config?: Record<string, unknown>
  nextRunAt?: string
  type: AgentTriggerType
}): Date | undefined | null => {
  if (!SCHEDULER_TRIGGER_TYPES.includes(input.type)) {
    return input.nextRunAt ? new Date(input.nextRunAt) : undefined
  }

  // A recurring schedule may carry an end (`config.until`). This is the arming
  // path for API- and admin-created triggers — the worker's own
  // `computeInitialScheduleRunAt` does not run here — so the same guard has to
  // live on both, or a schedule submitted with an end already in the past arms
  // anyway and fires once before the scheduler notices.
  const withinEnd = (next: Date | null): Date | null => {
    if (!next) return null
    const until = parseScheduleUntil(input.config)
    return until && next.getTime() > until.getTime() ? null : next
  }

  if (input.type === 'scheduled') {
    if (input.nextRunAt) {
      return withinEnd(new Date(input.nextRunAt))
    }

    return withinEnd(computeNextCronRunAt({
      config: input.config,
      currentDate: new Date(),
    }))
  }

  const intervalMinutes = parseIntervalMinutes(input.config)
  if (!intervalMinutes) {
    return null
  }

  return withinEnd(
    input.nextRunAt
      ? new Date(input.nextRunAt)
      : new Date(Date.now() + intervalMinutes * 60_000),
  )
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
