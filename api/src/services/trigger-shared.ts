import { Prisma, type PrismaClient } from '@prisma/client'
import {
  MAX_DELIVERY_RETRIES,
  computeNextRetryAt,
} from '@nessie/runtime'
import { parseRunId, type AgentTriggerRecord } from '@nessie/schemas'
import { toTimestamp } from '@nessie/workspace-admin'
import type { AgentTriggerDeliveryRecord } from '../contracts.js'

// Dispatch-side internals for the trigger service: delivery mapping, payload
// normalization, retry bookkeeping, and the DispatchTriggerResult contract.
// The create-side internals (record mapping, schedule arming, webhook config,
// target resolution) live in `@nessie/workspace-admin` because the worker
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
} from '@nessie/workspace-admin'

export type WorkflowTriggerPrismaLike = Pick<
  PrismaClient,
  'agentTrigger' | 'workflowInstallation'
>

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
  dedupeKey: delivery.dedupeKey ?? undefined,
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
