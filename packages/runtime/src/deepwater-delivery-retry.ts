import { Prisma } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import {
  DEEP_WATER_RETRYABLE_DELIVERY_BLOCKS,
  DEEP_WATER_RUN_DELIVER_TOPIC,
  DeepWaterRunDeliverJobPayloadSchema,
  deepWaterRunDeliverJobKey,
  type DeepWaterRequesterIdentity,
} from '@nessie/schemas'

import { refreshDeepWaterRunIdentity } from './deepwater-brief-identity.js'
import { clearDeepWaterDeliveryBlock } from './deepwater-brief-delivery.js'
import {
  lockDeepWaterBriefRun,
  readDeepWaterBriefRun,
  type DeepWaterBriefDb,
  type DeepWaterBriefRun,
} from './deepwater-brief-run-record.js'

/**
 * A person's Retry on a blocked delivery (`POST …/research-runs/:runId/deliver`,
 * Water plan nessie.md §7.1, amendments N3): the block is lifted and the
 * delivery job enqueued in one transaction, keyed by the request's `actionId`,
 * so a retried request never enqueues twice.
 *
 * A changed sign-in is lifted only by that same person signing in again: the
 * live identity must renew the captured one (same UOA subject, organisation
 * and team, no older epoch — amendments-fable F4), which clears the block in
 * the same statement. Any other retryable block is simply lifted; the job
 * renews the identity before it reads.
 */

const DELIVERY_RETRY_MAX_ATTEMPTS = 3

export type DeepWaterDeliveryRetryStart =
  | { kind: 'started'; run: DeepWaterBriefRun }
  /** This actionId was accepted before: nothing is enqueued again. */
  | { kind: 'replay'; run: DeepWaterBriefRun }
  /** Delivered, never blocked, or blocked for a reason no retry can fix. */
  | { kind: 'not_blocked'; run: DeepWaterBriefRun }
  /** Blocked on a changed sign-in, and this session is not that same person. */
  | { kind: 'identity_mismatch'; run: DeepWaterBriefRun }
  | { kind: 'not_found' }

const wasRetryAccepted = async (tx: DeepWaterBriefDb, runId: string, actionId: string): Promise<boolean> => {
  const rows = await tx.$queryRaw<Array<{ accepted: boolean }>>(Prisma.sql`
    SELECT true AS "accepted" FROM "queue_jobs"
    WHERE "idempotency_key" = ${deepWaterRunDeliverJobKey(runId, actionId)}
  `)
  return rows.length > 0
}

export const beginDeepWaterDeliveryRetry = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string; actionId: string; identity: DeepWaterRequesterIdentity },
): Promise<DeepWaterDeliveryRetryStart> => {
  const locked = await lockDeepWaterBriefRun(tx, input)
  if (!locked || locked.run.scopeState === null) return { kind: 'not_found' }
  const { run } = locked
  if (await wasRetryAccepted(tx, run.id, input.actionId)) return { kind: 'replay', run }

  const reason = run.deliveryBlockedReason
  if (run.deliveredAt !== null || reason === null || !DEEP_WATER_RETRYABLE_DELIVERY_BLOCKS.has(reason)) {
    return { kind: 'not_blocked', run }
  }
  if (reason === 'requester_identity_changed') {
    const renewed = await refreshDeepWaterRunIdentity(tx, input)
    if (!renewed.unblocked) return { kind: 'identity_mismatch', run }
  } else if (!await clearDeepWaterDeliveryBlock(tx, input)) {
    return { kind: 'not_blocked', run }
  }

  const enqueued = await enqueueQueueJob(tx, {
    idempotencyKey: deepWaterRunDeliverJobKey(run.id, input.actionId),
    maxAttempts: DELIVERY_RETRY_MAX_ATTEMPTS,
    payload: DeepWaterRunDeliverJobPayloadSchema.parse({
      organizationId: input.organizationId,
      runId: run.id,
      actionId: input.actionId,
      identity: input.identity,
    }),
    topic: DEEP_WATER_RUN_DELIVER_TOPIC,
  })
  if (!enqueued) {
    // Accepted only under this row's lock, which the read above held.
    throw new Error(`DeepWater delivery retry ${input.actionId} on run ${run.id} was accepted outside the run's lock`)
  }
  const next = await readDeepWaterBriefRun(tx, input)
  if (!next) throw new Error(`DeepWater run ${run.id} vanished under its own row lock`)
  return { kind: 'started', run: next }
}
