import type { PrismaClient } from '@prisma/client'

/**
 * One periodic sweep, run by one instance per tick.
 *
 * Horizontal-scaling invariant 2 (docs/standards/horizontal-scaling.md): a
 * sweep whose body is one indivisible walk cannot claim its work row by row,
 * so it takes a Postgres advisory lock instead. Three properties are
 * load-bearing and none of them is negotiable at a call site:
 *
 * - **`try`, never the blocking `pg_advisory_lock`.** A blocking wait would
 *   pile every replica's ticks behind the holder and turn a slow sweep into a
 *   connection leak. A tick that does not get the lock is *skipped*, and the
 *   caller treats `{ ran: false }` as a normal outcome, never an error.
 * - **`_xact_`, never the session variant.** Both the Prisma client and the
 *   `pg` `Pool` hand connections back when a statement finishes, so a
 *   session-scoped lock would be released by whoever happened to reuse the
 *   connection — or never. A transaction-scoped lock is released by the
 *   transaction ending, on every path including a crash.
 * - **`hashtextextended(name, 0)`.** Advisory locks are keyed by a bigint;
 *   hashing the name in SQL with Postgres' own 64-bit text hash means every
 *   caller maps a name to the same key with no shared hashing helper to keep
 *   in step.
 *
 * The lock connection only holds the lock. `fn` runs the sweep against the
 * caller's ordinary client, so the body is not confined to one transaction
 * and a long walk does not accumulate a transaction's worth of row locks.
 */

/** A sweep either ran under the lock, or another instance held it. */
export type SweepLockOutcome<T> = { ran: true; result: T } | { ran: false }

/**
 * Structural seam for a `pg` `Pool`. `pg` is not a dependency of this package
 * and does not need to be: the lock needs exactly one pooled client, held for
 * the body's duration and always released. `PgRealtimeTransport` owns a
 * `Pool` and no Prisma client, which is why this overload exists at all.
 */
export type SweepLockPool = {
  connect: () => Promise<{
    query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
    release: () => void
  }>
}

export type SweepLockOptions = {
  /**
   * How long the lock may be held, in milliseconds. On the Prisma path this
   * is the interactive-transaction `timeout`, and passing it explicitly is
   * mandatory rather than cosmetic: Prisma defaults to **5 seconds**, so a
   * sweep that walks a registry or deletes a day of events would have its
   * lock transaction rolled out from under it while the body kept running —
   * the lock released, every other replica free to start the same walk. Ten
   * minutes is the ceiling, not a budget; a body that needs longer should be
   * claiming its work row by row instead.
   */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Prisma's `maxWait` is how long the transaction may queue for a pool
 * connection before it gives up; the 2 s default is short enough that a
 * momentarily busy pool turns a skippable tick into a thrown error. Ten
 * seconds keeps a contended tick a *skip*, which is what callers expect.
 */
const MAX_WAIT_MS = 10_000

const LOCK_SQL = 'SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS locked'

const isLocked = (row: unknown): boolean =>
  typeof row === 'object' && row !== null && (row as { locked?: unknown }).locked === true

const skipped = <T>(name: string): SweepLockOutcome<T> => {
  console.debug(`[sweep-lock] '${name}' is held by another instance, skipping this tick`)
  return { ran: false }
}

const withPrismaSweepLock = async <T>(
  prisma: PrismaClient,
  name: string,
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<SweepLockOutcome<T>> =>
  prisma.$transaction(
    async (tx): Promise<SweepLockOutcome<T>> => {
      const rows = await tx.$queryRaw<
        unknown[]
      >`SELECT pg_try_advisory_xact_lock(hashtextextended(${name}::text, 0)) AS locked`
      if (!isLocked(rows[0])) return skipped(name)
      return { ran: true, result: await fn() }
    },
    { maxWait: MAX_WAIT_MS, timeout: timeoutMs },
  )

const withPoolSweepLock = async <T>(
  pool: SweepLockPool,
  name: string,
  fn: () => Promise<T>,
): Promise<SweepLockOutcome<T>> => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(LOCK_SQL, [name])
    if (!isLocked(result.rows[0])) return skipped(name)
    return { ran: true, result: await fn() }
  } finally {
    // The lock connection never writes, so ROLLBACK is correct on every path
    // and is the one statement that ends the transaction — and with it the
    // lock — whether the body returned, skipped or threw. Its own failure
    // (a connection already gone) must not mask the body's error, and
    // `release` has to happen either way or the pool leaks a client.
    await client.query('ROLLBACK').catch(() => undefined)
    client.release()
  }
}

/**
 * Run `fn` while holding the advisory lock named `name`, or skip this tick.
 *
 * Accepts either a Prisma client or a `pg` `Pool`, because the sweeps that
 * need it have one or the other and never both.
 */
export const withSweepLock = async <T>(
  db: PrismaClient | SweepLockPool,
  name: string,
  fn: () => Promise<T>,
  options: SweepLockOptions = {},
): Promise<SweepLockOutcome<T>> =>
  '$transaction' in db
    ? withPrismaSweepLock(db, name, fn, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    : withPoolSweepLock(db, name, fn)
