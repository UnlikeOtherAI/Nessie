import { createHash, randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

/**
 * The one fixed-window counter store, shared by every rate limit in the
 * deployment (docs/rate-limiting.md; docs/standards/horizontal-scaling.md
 * invariant 1).
 *
 * One `rate_limit_buckets` row per `(bucket, key_hash, window_start)`, moved by
 * a single `INSERT … ON CONFLICT DO UPDATE`, so N replicas count against the
 * same row instead of each keeping a private `Map` that makes the effective
 * limit `max × N`. Windows are fixed rather than sliding: an identity costs one
 * row per live window, the unique key makes the statement atomic, and expired
 * rows are pruned by the caller — a true sliding log would need an unbounded
 * event table and a transaction per hit. The price of a fixed window is the
 * boundary: an identity can spend a whole window's allowance at its end and the
 * next one's at its start, so the guarantee is `max` per window and at worst
 * `2 × max` across a sliding window. That is bounded and independent of the
 * replica count, which is the property that matters here.
 *
 * Two policies sit on that one statement, and which one a caller wants is a
 * real decision rather than an accident:
 *
 *  - `countRateLimitHit` counts **every attempt**, admitted or not, and reports
 *    whether the count is over the limit. This is what an inbound guard wants:
 *    a brute-force flood should be visible in the counter (it is what the
 *    lockout audit event reads) even though every request past `max` is
 *    refused. `api/src/services/rate-limit.ts` is the caller.
 *  - `takeRateLimitSlot` is a **conditional UPDATE**: the increment carries a
 *    `WHERE count < max`, so a refused caller does not move the counter and the
 *    row is exactly the number of calls admitted in that window. This is what
 *    an outbound pacer wants, because a pacer polls in a loop while it waits
 *    and must not spend the very slots it is waiting for.
 *    `worker/src/control/automatic-membership/rate-limit.ts` is the caller.
 *
 * Neither function fails open on its own — the store errors reach the caller,
 * because "allow" and "pace anyway" are different decisions and the caller owns
 * which one its surface can afford.
 */

/** A limit expressed as `max` events per fixed `windowMs` window. */
export type FixedWindowRule = {
  max: number
  windowMs: number
}

/**
 * The two raw-SQL escape hatches this store needs. Structural rather than the
 * whole `PrismaClient` so a test can hand in a fake, and so the worker can pass
 * whatever client it already holds.
 */
export type RateLimitWindowStore = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>

/**
 * The store key. Raw IPs, user ids and organisation ids are never written to
 * the counters table: the key is `sha256(bucket:identity)`, which is also why
 * the column is called `key_hash`.
 */
export const rateLimitKeyHash = (bucket: string, identity: string): string =>
  createHash('sha256').update(`${bucket}:${identity}`).digest('hex')

/** The start of the fixed window `nowMs` falls in. Aligned to the epoch. */
export const rateLimitWindowStart = (nowMs: number, windowMs: number): number =>
  Math.floor(nowMs / windowMs) * windowMs

export type RateLimitWindowHit = {
  bucket: string
  /** Attempts recorded in this window, including this one. */
  count: number
  limit: number
  limited: boolean
  /** Milliseconds until this window rolls and the counter resets. Always > 0. */
  resetInMs: number
  retryAfterSeconds: number
}

export type RateLimitSlot = {
  bucket: string
  /** True when the conditional UPDATE moved the counter for this caller. */
  admitted: boolean
  /**
   * Calls admitted in this window, including this one. A refusal returns no
   * row, so this falls back to `rule.max` — the true count is at least that,
   * and no caller should read it as an exact figure on the refused path.
   */
  count: number
  /** The window the decision was made in, so a caller can attribute it. */
  windowStartMs: number
  /** Milliseconds until this window rolls and the allowance refills. Always > 0. */
  resetInMs: number
}

const windowShape = (
  nowMs: number,
  rule: FixedWindowRule,
): { windowStartMs: number; resetInMs: number } => {
  const windowStartMs = rateLimitWindowStart(nowMs, rule.windowMs)
  return { resetInMs: windowStartMs + rule.windowMs - nowMs, windowStartMs }
}

/**
 * Record one attempt against `(bucket, keyHash)` and say whether the window's
 * allowance is spent. Every attempt moves the counter, refusals included.
 */
export const countRateLimitHit = async (
  store: RateLimitWindowStore,
  input: { bucket: string; keyHash: string; rule: FixedWindowRule; nowMs?: number },
): Promise<RateLimitWindowHit> => {
  const nowMs = input.nowMs ?? Date.now()
  const { resetInMs, windowStartMs } = windowShape(nowMs, input.rule)
  const rows = await store.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "rate_limit_buckets"
      ("id", "bucket", "key_hash", "window_start", "count", "updated_at")
    VALUES (
      ${randomUUID()}::uuid,
      ${input.bucket},
      ${input.keyHash},
      ${new Date(windowStartMs)},
      1,
      NOW()
    )
    ON CONFLICT ("bucket", "key_hash", "window_start")
    DO UPDATE SET "count" = "rate_limit_buckets"."count" + 1,
                  "updated_at" = NOW()
    RETURNING "count"
  `
  const count = rows[0]?.count ?? 1
  return {
    bucket: input.bucket,
    count,
    limit: input.rule.max,
    limited: count > input.rule.max,
    resetInMs,
    retryAfterSeconds: Math.max(1, Math.ceil(resetInMs / 1000)),
  }
}

/**
 * Take one slot from `(bucket, keyHash)` if the window still has one.
 *
 * The increment is conditional — `DO UPDATE … WHERE count < max` — so a refused
 * caller returns no row and leaves the counter alone. Postgres re-reads the
 * latest committed row version before evaluating that `WHERE`, which is what
 * makes the cap hold when several replicas race for the last slot.
 */
export const takeRateLimitSlot = async (
  store: RateLimitWindowStore,
  input: { bucket: string; keyHash: string; rule: FixedWindowRule; nowMs?: number },
): Promise<RateLimitSlot> => {
  const nowMs = input.nowMs ?? Date.now()
  const { resetInMs, windowStartMs } = windowShape(nowMs, input.rule)
  if (input.rule.max < 1) {
    return { admitted: false, bucket: input.bucket, count: 0, resetInMs, windowStartMs }
  }
  const rows = await store.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "rate_limit_buckets"
      ("id", "bucket", "key_hash", "window_start", "count", "updated_at")
    VALUES (
      ${randomUUID()}::uuid,
      ${input.bucket},
      ${input.keyHash},
      ${new Date(windowStartMs)},
      1,
      NOW()
    )
    ON CONFLICT ("bucket", "key_hash", "window_start")
    DO UPDATE SET "count" = "rate_limit_buckets"."count" + 1,
                  "updated_at" = NOW()
    WHERE "rate_limit_buckets"."count" < ${input.rule.max}
    RETURNING "count"
  `
  const row = rows[0]
  return {
    admitted: row !== undefined,
    bucket: input.bucket,
    count: row?.count ?? input.rule.max,
    resetInMs,
    windowStartMs,
  }
}

/**
 * Delete rows whose window has already passed, scoped to one bucket. The scope
 * is load-bearing: buckets run on different window lengths, so a short-window
 * sweep must never delete a longer bucket's live rows.
 */
export const pruneRateLimitWindows = async (
  store: RateLimitWindowStore,
  input: { bucket: string; before: Date },
): Promise<void> => {
  await store.$executeRaw`
    DELETE FROM "rate_limit_buckets"
    WHERE "bucket" = ${input.bucket} AND "window_start" < ${input.before}
  `
}

/**
 * Forget every window of one bucket, live ones included. A test seam: it
 * discards allowance the running deployment is relying on, so it belongs to a
 * suite that owns its database, never to request-path code.
 */
export const clearRateLimitWindows = async (
  store: RateLimitWindowStore,
  bucket: string,
): Promise<void> => {
  await store.$executeRaw`DELETE FROM "rate_limit_buckets" WHERE "bucket" = ${bucket}`
}
