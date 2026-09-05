import type { PrismaClient } from '@prisma/client'
import {
  BOARD_SOURCE_HEALTH_ALERT_TOPIC,
  BOARD_SOURCE_SYNC_INCREMENTAL_TOPIC,
  BOARD_SOURCE_WEBHOOK_PROCESS_TOPIC,
  COMMS_SUBSCRIPTIONS_RENEW_TOPIC,
  COMMS_SYNC_INCREMENTAL_TOPIC,
  COMMS_SYNC_INCREMENTAL_SWEEP_TOPIC,
  type CommsIncrementalSweepJobPayload,
  type CommsSubscriptionsRenewJobPayload,
  type CommsSyncIncrementalJobPayload,
} from '@nessie/schemas'
import { enqueueQueueJob } from '@nessie/db'

// The raw queue insert + run.execute enqueue live in `@nessie/db` (shared with
// the API and with the thread-serialization drain); re-exported here so
// existing worker call sites keep their import path.
export { enqueueQueueJob, enqueueRunExecution } from '@nessie/db'

/**
 * Enqueue the communications subscription-renewal sweep. The caller supplies a
 * window-bucketed idempotency key so multiple worker replicas ticking their
 * interval do not stack duplicate sweeps for the same window.
 */
export const enqueueCommsSubscriptionsRenew = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: CommsSubscriptionsRenewJobPayload,
  idempotencyKey?: string,
): Promise<boolean> => {
  return enqueueQueueJob(prisma, {
    idempotencyKey,
    payload,
    topic: COMMS_SUBSCRIPTIONS_RENEW_TOPIC,
  })
}

/**
 * Enqueue an incremental sync for one communications connection. Webhook
 * processing uses this to nudge a token-gated delta pull after a provider push;
 * a window-bucketed idempotency key coalesces bursts of deliveries for the same
 * connection into a single sync instead of one per event.
 */
export const enqueueCommsIncrementalSync = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: CommsSyncIncrementalJobPayload,
  idempotencyKey?: string,
): Promise<boolean> => {
  return enqueueQueueJob(prisma, {
    idempotencyKey,
    payload,
    topic: COMMS_SYNC_INCREMENTAL_TOPIC,
  })
}

/** Queue one bounded reconciliation sweep for non-push comms connectors. */
export const enqueueCommsIncrementalSweep = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: CommsIncrementalSweepJobPayload,
  idempotencyKey?: string,
): Promise<boolean> => enqueueQueueJob(prisma, {
  idempotencyKey,
  payload,
  topic: COMMS_SYNC_INCREMENTAL_SWEEP_TOPIC,
})

/**
 * Board-source jobs. Each carries an idempotency key at its natural
 * granularity: one sync per source (a slow provider must not pile up), one
 * alert per health transition, and one renewal sweep per window.
 */
export const enqueueBoardSourceSync = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: { sourceId: string },
  idempotencyKey?: string,
): Promise<boolean> =>
  enqueueQueueJob(prisma, {
    idempotencyKey: idempotencyKey ?? `board-source:sync:${payload.sourceId}`,
    payload,
    topic: BOARD_SOURCE_SYNC_INCREMENTAL_TOPIC,
  })

export const enqueueBoardSourceWebhook = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: {
    provider: string
    headers: Record<string, string>
    rawBody: string
    token?: string
  },
  idempotencyKey?: string,
): Promise<boolean> =>
  enqueueQueueJob(prisma, {
    idempotencyKey,
    payload,
    topic: BOARD_SOURCE_WEBHOOK_PROCESS_TOPIC,
  })

export const enqueueBoardSourceHealthAlert = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: { sourceId: string; revision: number },
): Promise<boolean> =>
  enqueueQueueJob(prisma, {
    idempotencyKey: `board-source:health:${payload.sourceId}:${payload.revision}`,
    payload,
    topic: BOARD_SOURCE_HEALTH_ALERT_TOPIC,
  })
