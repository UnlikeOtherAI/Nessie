import { Prisma } from '@prisma/client'

import type { PushSendClaimPrisma } from './push-send-claim.js'

/**
 * Delete push send claims old enough that nothing can consult them again.
 *
 * `push_send_claims` gets one row per notification per endpoint, so an active
 * organisation writes tens of thousands a day, each with an entry in the unique
 * index. Nothing else removes them: a `sent` claim is permanent by design and a
 * failed one is already deleted on the spot, so without this the table and its
 * index grow forever.
 *
 * ## Why this horizon
 *
 * A claim only ever matters while the job that would consult it can still be
 * redelivered. A `push.dispatch` job is bounded by `max_attempts` (3,
 * `packages/db/src/queue.ts`) times the queue's 300 s lock TTL — a quarter of an
 * hour at the outside — so a day is ~100x the longest window in which any claim
 * is still live.
 *
 * Reaping cannot resurrect a duplicate either, because every `notification_key`
 * embeds the fact that makes the notification unique: a message id, a ring
 * revision, a period start. There is no key a caller can legitimately present a
 * day later expecting it to still be claimed — the once-per-period budget
 * dedupe is the `budget_alerts` marker, taken before the enqueue, not this
 * table.
 *
 * ## Why no lock
 *
 * No claim, no lock, and no leader: this is a single idempotent DELETE whose
 * predicate is an age, so N replicas running it in the same tick race to delete
 * the same already-expired rows and the losers delete nothing. It is not one of
 * the sweeps that needs `withSweepLock` (docs/standards/horizontal-scaling.md
 * §2) — there is no multi-step walk to duplicate.
 */
export const PUSH_SEND_CLAIM_RETENTION_MS = 24 * 60 * 60 * 1000

/** How often the worker runs the reaper. Nothing depends on the cadence. */
export const PUSH_SEND_CLAIM_SWEEP_INTERVAL_MS = 15 * 60 * 1000

export const sweepExpiredPushSendClaims = async (
  prisma: PushSendClaimPrisma,
): Promise<number> => {
  const retentionSeconds = PUSH_SEND_CLAIM_RETENTION_MS / 1000
  const deleted = await prisma.$executeRaw(
    Prisma.sql`
      DELETE FROM push_send_claims
      WHERE claimed_at < now() - make_interval(secs => ${retentionSeconds}::double precision)
    `,
  )
  return Number(deleted)
}
