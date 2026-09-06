import { Prisma, type PrismaClient } from '@prisma/client'
import {
  MAX_DELIVERY_RETRIES,
  computeNextRetryAt,
} from '@nessie/runtime'
import {
  parseRunId,
  type AgentTriggerRecord,
  type TriggerFireSkipReason,
} from '@nessie/schemas'
import { toTimestamp } from '@nessie/team-admin'
import type { AgentTriggerDeliveryRecord } from '../contracts/triggers.js'
import { toInputJson } from '../db/prisma-json.js'
import { isWorkflowInstallationRunnable } from './workflow-templates.js'

// Dispatch-side internals for the trigger service: delivery mapping, payload
// normalization, retry bookkeeping, and the DispatchTriggerResult contract.
// The create-side internals (record mapping, schedule arming, webhook config,
// target resolution) live in `@nessie/team-admin` because the worker
// creates triggers too; they are re-exported so importers keep one import site.
export {
  ensureWebhookConfig,
  extractWebhookApiKey,
  isJsonRecord,
  mapTriggerRecord,
  normalizeNextRunAt,
  resolveExecutionTarget,
  SCHEDULER_TRIGGER_TYPES,
  toTimestamp,
  TRIGGER_ADMIN_AUDIENCE,
} from '@nessie/team-admin'

export type WorkflowTriggerPrismaLike = Pick<
  PrismaClient,
  'agentTrigger' | 'workflowInstallation'
>

const stripDedupeNamespace = (
  dedupeKey: string | null,
  source: string | null,
): string | null => {
  if (!dedupeKey || !source) return dedupeKey
  const prefix = `${source}:`
  return dedupeKey.startsWith(prefix) ? dedupeKey.slice(prefix.length) : dedupeKey
}

export const mapTriggerDeliveryRecord = (delivery: {
  createdAt: Date
  dedupeKey: string | null
  deliveredAt: Date | null
  errorMessage: string | null
  id: string
  payload: unknown
  // `status` is selected only where the run's outcome matters (the deliveries
  // list); dispatch-time callers create the run as `pending` and omit it.
  run: { id: string; status?: string } | null
  source: string | null
  status: 'pending' | 'delivered' | 'failed' | 'skipped' | 'skipped_overlap'
  triggerId: string
}): AgentTriggerDeliveryRecord => ({
  id: delivery.id,
  triggerId: delivery.triggerId,
  // Presented as the caller wrote it. Dispatch prefixes a caller-supplied key
  // with the route's own source so a caller can never occupy the scheduler's
  // predictable `scheduled:<id>:<ISO>` key, but that namespace is a server
  // detail: a client that reads a delivery back and replays its key must get
  // the same idempotent result, not a double-prefixed miss.
  dedupeKey: stripDedupeNamespace(delivery.dedupeKey, delivery.source) ?? undefined,
  status: delivery.status,
  source: delivery.source ?? undefined,
  payload: delivery.payload,
  errorMessage: delivery.errorMessage ?? undefined,
  runId: delivery.run ? parseRunId(delivery.run.id) : undefined,
  ...(delivery.run?.status ? { runStatus: delivery.run.status } : {}),
  deliveredAt: toTimestamp(delivery.deliveredAt),
  createdAt: delivery.createdAt.toISOString(),
})

export const normalizePayload = (payload: unknown): Prisma.InputJsonValue => {
  if (payload === null) {
    return toInputJson(Prisma.JsonNull)
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
      // The four claim-time reasons come from `@nessie/schemas` because the
      // worker writes them onto the delivery row when the same question is
      // re-asked after the ack; `webhook_secret_mismatch` is the one rejection
      // only an inbound request can produce, so it never reaches a job.
      reason: TriggerFireSkipReason | 'webhook_secret_mismatch'
    }
  | {
      delivery: AgentTriggerDeliveryRecord
      existing: boolean
      kind: 'queued'
      runId?: ReturnType<typeof parseRunId>
      trigger: AgentTriggerRecord
      workflowRunId?: string
    }

/**
 * Whether a trigger would fire right now, without firing it.
 *
 * The webhook intake enqueues rather than dispatching
 * (docs/standards/horizontal-scaling.md § 3), and an enqueue on its own cannot
 * tell a sender that its trigger is paused or that its agent is bound to no
 * channel — the two things a misconfigured integration has to hear on the
 * delivery it sent, and exactly what `POST /api/triggers/webhook`'s 409s carry.
 * So the questions a couple of indexed lookups can answer stay on the request
 * path, and only the fire itself moves.
 *
 * This is a *predicate*, deliberately not a second dispatcher: what decides
 * whether a fire happens is still `queueTriggerRun`'s own gate, re-evaluated in
 * the worker because a trigger can be paused between the ack and the fire. It
 * mirrors that gate rather than `dispatchAgentTrigger`'s in one place — the
 * personal assistant is exempt from the *binding* check, being its owner's
 * delegate rather than an agent bound to channels — so the receiver never
 * refuses a delivery the worker would happily have fired.
 *
 * The worker asks the same question again when it claims the job, and answers
 * it in the same four words: a fire the recheck stops writes a terminal
 * `skipped` delivery carrying the reason, so the `dedupeKey` this route's 202
 * handed out always resolves to something.
 */
export type TriggerFireReadiness =
  | { kind: 'ready' }
  | {
      kind: 'not_ready'
      reason: TriggerFireSkipReason
    }

const notReady = (reason: TriggerFireSkipReason): TriggerFireReadiness => ({
  kind: 'not_ready',
  reason,
})

export const resolveTriggerFireReadiness = async (
  prisma: PrismaClient,
  triggerId: string,
): Promise<TriggerFireReadiness> => {
  const trigger = await prisma.agentTrigger.findUnique({
    where: { id: triggerId },
    select: {
      agent: { select: { agentKind: true } },
      agentId: true,
      enabled: true,
      status: true,
      targetChannelId: true,
      targetThreadId: true,
      workflowInstallation: { select: { active: true, status: true } },
      workflowInstallationId: true,
    },
  })

  if (!trigger) return notReady('trigger_not_found')
  if (!trigger.enabled || trigger.status !== 'active') return notReady('trigger_paused')

  if (trigger.workflowInstallationId) {
    return trigger.workflowInstallation
      && isWorkflowInstallationRunnable(trigger.workflowInstallation)
      ? { kind: 'ready' }
      : notReady('workflow_installation_not_ready')
  }

  if (!trigger.agentId || !trigger.agent) return notReady('agent_not_bound')
  if (!trigger.targetChannelId || !trigger.targetThreadId) return notReady('agent_not_bound')

  const thread = await prisma.thread.findUnique({
    where: { id: trigger.targetThreadId },
    select: { channelId: true },
  })
  if (!thread || thread.channelId !== trigger.targetChannelId) {
    return notReady('agent_not_bound')
  }

  if (trigger.agent.agentKind === 'personal_assistant') return { kind: 'ready' }

  const binding = await prisma.agentBinding.findFirst({
    where: { agentId: trigger.agentId, channelId: trigger.targetChannelId },
    select: { id: true },
  })
  return binding ? { kind: 'ready' } : notReady('agent_not_bound')
}
