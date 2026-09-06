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
 * **The window comes from the database's clock, never from a caller's.**
 * `window_start` is part of the conflict key, so it is the column that decides
 * whether two replicas are counting the same thing. Computing it in the process
 * — `Math.floor(Date.now() / windowMs)` — meant two workers whose clocks
 * disagreed by more than a fraction of a window inserted *different* rows for
 * the same real instant and each got a private counter, silently, with nothing
 * in the logs to say why; a badly skewed host kept its own cap indefinitely.
 * Every statement below therefore derives the window from `NOW()` inside the
 * statement and returns the window and the database's own `now` it was derived
 * from, so a caller's `resetInMs` is anchored to the same clock as its window.
 * Fleet clock sync stops being a correctness input.
 *
 * `nowMs` survives as an explicit **override of the database clock**, bound as
 * a parameter into that same expression rather than replacing it in the
 * process: a suite that needs to pin a window still can, and the default —
 * every production caller — is `NULL`, meaning `NOW()`.
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

/**
 * The start of the fixed window `nowMs` falls in. Aligned to the epoch — the
 * same flooring the statements below do in SQL, for a caller (a test, a log
 * line) that needs to name a window without issuing one.
 */
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

/**
 * What every statement below returns: the counter (NULL when a conditional
 * increment declined to move it) plus the window and the database `now` it was
 * derived from, both in epoch milliseconds.
 */
type WindowRow = {
  count: number | null
  window_start_ms: bigint | number
  now_ms: bigint | number
}

const readWindowRow = (
  rows: WindowRow[],
  rule: FixedWindowRule,
): { count: number | null; nowMs: number; windowStartMs: number; resetInMs: number } => {
  const row = rows[0]
  // A statement that reaches here always returns exactly one row: the window
  // CTE is unconditional and the counter is a scalar sub-select over it. An
  // empty result would mean the store answered something this module did not
  // write, so it is a defect rather than a refusal.
  if (row === undefined) {
    throw new Error('rate-limit window statement returned no row')
  }
  const nowMs = Number(row.now_ms)
  const windowStartMs = Number(row.window_start_ms)
  return {
    count: row.count === null ? null : Number(row.count),
    nowMs,
    resetInMs: windowStartMs + rule.windowMs - nowMs,
    windowStartMs,
  }
}

/**
 * Record one attempt against `(bucket, keyHash)` and say whether the window's
 * allowance is spent. Every attempt moves the counter, refusals included.
 *
 * `nowMs` overrides the database's clock for this one statement; leave it unset
 * (every production caller does) and the window comes from `NOW()`.
 */
export const countRateLimitHit = async (
  store: RateLimitWindowStore,
  input: { bucket: string; keyHash: string; rule: FixedWindowRule; nowMs?: number },
): Promise<RateLimitWindowHit> => {
  const rows = await store.$queryRaw<WindowRow[]>`
    WITH "clock" AS (
      SELECT
        COALESCE(
          ${input.nowMs ?? null}::double precision,
          (EXTRACT(EPOCH FROM NOW()) * 1000)::double precision
        ) AS "now_ms",
        ${input.rule.windowMs}::double precision AS "window_ms"
    ),
    "shape" AS (
      SELECT
        "now_ms",
        FLOOR("now_ms" / "window_ms") * "window_ms" AS "start_ms"
      FROM "clock"
    ),
    "hit" AS (
      INSERT INTO "rate_limit_buckets"
        ("id", "bucket", "key_hash", "window_start", "count", "updated_at")
      SELECT
        ${randomUUID()}::uuid,
        ${input.bucket},
        ${input.keyHash},
        TO_TIMESTAMP("shape"."start_ms" / 1000),
        1,
        NOW()
      FROM "shape"
      ON CONFLICT ("bucket", "key_hash", "window_start")
      DO UPDATE SET "count" = "rate_limit_buckets"."count" + 1,
                    "updated_at" = NOW()
      RETURNING "count"
    )
    SELECT
      (SELECT "count" FROM "hit") AS "count",
      "shape"."start_ms"::bigint AS "window_start_ms",
      "shape"."now_ms"::bigint AS "now_ms"
    FROM "shape"
  `
  const window = readWindowRow(rows, input.rule)
  const count = window.count ?? 1
  return {
    bucket: input.bucket,
    count,
    limit: input.rule.max,
    limited: count > input.rule.max,
    resetInMs: window.resetInMs,
    retryAfterSeconds: Math.max(1, Math.ceil(window.resetInMs / 1000)),
  }
}

/**
 * Take one slot from `(bucket, keyHash)` if the window still has one.
 *
 * The increment is conditional — `DO UPDATE … WHERE count < max` — so a refused
 * caller returns no row and leaves the counter alone. Postgres re-reads the
 * latest committed row version before evaluating that `WHERE`, which is what
 * makes the cap hold when several replicas race for the last slot. A `max`
 * below one admits nothing, which is why the INSERT itself is guarded: without
 * that guard a first caller for an unseen key would insert `count = 1` and be
 * admitted, because `ON CONFLICT` never fires on a fresh row.
 *
 * `nowMs` overrides the database's clock for this one statement; leave it unset
 * (every production caller does) and the window comes from `NOW()`.
 */
export const takeRateLimitSlot = async (
  store: RateLimitWindowStore,
  input: { bucket: string; keyHash: string; rule: FixedWindowRule; nowMs?: number },
): Promise<RateLimitSlot> => {
  const rows = await store.$queryRaw<WindowRow[]>`
    WITH "clock" AS (
      SELECT
        COALESCE(
          ${input.nowMs ?? null}::double precision,
          (EXTRACT(EPOCH FROM NOW()) * 1000)::double precision
        ) AS "now_ms",
        ${input.rule.windowMs}::double precision AS "window_ms"
    ),
    "shape" AS (
      SELECT
        "now_ms",
        FLOOR("now_ms" / "window_ms") * "window_ms" AS "start_ms"
      FROM "clock"
    ),
    "slot" AS (
      INSERT INTO "rate_limit_buckets"
        ("id", "bucket", "key_hash", "window_start", "count", "updated_at")
      SELECT
        ${randomUUID()}::uuid,
        ${input.bucket},
        ${input.keyHash},
        TO_TIMESTAMP("shape"."start_ms" / 1000),
        1,
        NOW()
      FROM "shape"
      WHERE ${input.rule.max}::int >= 1
      ON CONFLICT ("bucket", "key_hash", "window_start")
      DO UPDATE SET "count" = "rate_limit_buckets"."count" + 1,
                    "updated_at" = NOW()
      WHERE "rate_limit_buckets"."count" < ${input.rule.max}::int
      RETURNING "count"
    )
    SELECT
      (SELECT "count" FROM "slot") AS "count",
      "shape"."start_ms"::bigint AS "window_start_ms",
      "shape"."now_ms"::bigint AS "now_ms"
    FROM "shape"
  `
  const window = readWindowRow(rows, input.rule)
  return {
    admitted: window.count !== null,
    bucket: input.bucket,
    count: window.count ?? input.rule.max,
    resetInMs: window.resetInMs,
    windowStartMs: window.windowStartMs,
  }
}

/**
 * Delete rows whose window has already passed, scoped to one bucket. The scope
 * is load-bearing: buckets run on different window lengths, so a short-window
 * sweep must never delete a longer bucket's live rows.
 *
 * The cutoff is `NOW() - olderThanMs` **computed in the database**, for the same
 * reason the window is: a replica whose clock ran fast would otherwise delete
 * the live window a slower replica is still counting against, handing that
 * replica a fresh allowance and widening the cap with nothing to show for it.
 * `nowMs` overrides that clock for a suite that pinned its windows.
 */
export const pruneRateLimitWindows = async (
  store: RateLimitWindowStore,
  input: { bucket: string; olderThanMs: number; nowMs?: number },
): Promise<void> => {
  await store.$executeRaw`
    DELETE FROM "rate_limit_buckets"
    WHERE "bucket" = ${input.bucket}
      AND "window_start" < TO_TIMESTAMP(
        (
          COALESCE(
            ${input.nowMs ?? null}::double precision,
            (EXTRACT(EPOCH FROM NOW()) * 1000)::double precision
          ) - ${input.olderThanMs}::double precision
        ) / 1000
      )
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
