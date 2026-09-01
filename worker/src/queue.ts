import type { PrismaClient } from '@prisma/client'
import {
  COMMS_SUBSCRIPTIONS_RENEW_TOPIC,
  COMMS_SYNC_INCREMENTAL_TOPIC,
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
