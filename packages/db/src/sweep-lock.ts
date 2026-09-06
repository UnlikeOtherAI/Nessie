/**
 * One periodic sweep, run by one instance per tick.
 *
 * Horizontal-scaling invariant 2 (docs/standards/horizontal-scaling.md): a
 * sweep whose body is one indivisible walk cannot claim its work row by row,
 * so it takes a Postgres advisory lock instead. Four properties are
 * load-bearing and none of them is negotiable at a call site:
 *
 * - **`try`, never the blocking `pg_advisory_lock`.** A blocking wait would
 *   pile every replica's ticks behind the holder and turn a slow sweep into a
 *   connection leak. A tick that does not get the lock is *skipped*, and the
 *   caller treats `{ ran: false }` as a normal outcome, never an error.
 * - **Session-scoped, on a connection this helper holds for the whole body.**
 *   The lock has to outlive `fn`, and the earlier `pg_try_advisory_xact_lock`
 *   could not promise that: it was taken in a Prisma interactive transaction
 *   whose `timeout` aborted the *transaction* — releasing the lock — while
 *   `fn` was a plain promise nobody could cancel and kept running on the
 *   caller's own connection. The next replica's tick then acquired the lock
 *   and started a second body beside the first, which is precisely the
 *   duplicate this helper exists to prevent (the thirty-minute registry walk
 *   was the obvious victim, but an event-loop stall does it to any sweep).
 *   A session lock has no such deadline: it is held until this helper unlocks
 *   or the connection holding it goes away, and if the process dies that drop
 *   is exactly what is wanted — Postgres releases every lock the backend held.
 *   That is why the argument is a `pg` `Pool` and not a `PrismaClient` —
 *   Prisma hands a connection back between statements, so it cannot hold a
 *   session lock at all.
 *
 *   The residual is the same drop *without* the death. `fn` runs on the
 *   caller's client, not this one, so if only the lock connection is lost —
 *   the server terminates the backend, a proxy or an `idle_session_timeout`
 *   reaps a socket that has been idle since the probe, a network blip — then
 *   Postgres releases the lock while the body carries on, and the next tick on
 *   any replica may start a second one. Nothing here detects that, and the
 *   longest body (the thirty-minute registry walk) is also the one whose lock
 *   connection sits idle longest. So the property is "one body per tick unless
 *   the lock connection is lost under a running body", not an unconditional
 *   one.
 * - **The lock connection only holds the lock.** `fn` runs the sweep against
 *   the caller's ordinary client, so the body is not confined to one
 *   transaction and a long walk does not accumulate a transaction's worth of
 *   row locks.
 * - **`hashtextextended(name, 0)`.** Advisory locks are keyed by a bigint;
 *   hashing the name in SQL with Postgres' own 64-bit text hash means every
 *   caller maps a name to the same key with no shared hashing helper to keep
 *   in step. The unlock hashes the same way, so it targets the same key.
 */

/** A sweep either ran under the lock, or another instance held it. */
export type SweepLockOutcome<T> = { ran: true; result: T } | { ran: false }

/**
 * Structural seam for one `pg` pooled client. `release` takes pg's optional
 * error argument: passing one destroys the connection instead of returning it
 * to the pool, which is the only safe answer when the unlock did not run.
 */
export type SweepLockClient = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
  release: (destroy?: Error | boolean) => void
}

/**
 * Structural seam for a `pg` `Pool`. `pg` is not a dependency of this package
 * and does not need to be: the lock needs exactly one pooled client, held for
 * the body's duration and always released.
 */
export type SweepLockPool = {
  connect: () => Promise<SweepLockClient>
}

export type SweepLockOptions = {
  /**
   * How long to wait for a connection out of the pool before treating the
   * tick as contended and skipping it, in milliseconds.
   *
   * It bounds the *wait for a client*, never the body: a session lock has no
   * deadline, so there is nothing here that could be rolled out from under a
   * running sweep. The wait exists because the contract above promises a
   * contended tick is a skip: `pool.connect()` on an exhausted pool queues
   * forever, so without this a maintenance tick on a pool pinned by a
   * long-held lock would hang instead of skipping.
   */
  acquireTimeoutMs?: number
}

/**
 * Ten seconds. Long enough that a momentarily busy pool still gets a client:
 * a running sweep holds exactly one, for the whole length of its body — the
 * thirty-minute registry walk included, as the header says — so what a tick
 * competes with is a handful of long-held connections, not churn. And short
 * enough that a genuinely saturated pool skips the tick rather than parking a
 * pending acquire on it until the next tick adds another.
 */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000

const LOCK_SQL = 'SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS locked'
const UNLOCK_SQL = 'SELECT pg_advisory_unlock(hashtextextended($1::text, 0)) AS unlocked'

const isLocked = (row: unknown): boolean =>
  typeof row === 'object' && row !== null && (row as { locked?: unknown }).locked === true

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error))

/**
 * Borrow a client, or give up and let the caller skip.
 *
 * A `connect` that lands *after* the deadline is still released: abandoning it
 * would leak one connection per skipped tick, which on a once-a-minute sweep
 * exhausts the pool in an afternoon.
 */
const acquireClient = async (
  pool: SweepLockPool,
  timeoutMs: number,
): Promise<SweepLockClient | null> => {
  const connecting = pool.connect()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })

  try {
    const client = await Promise.race([connecting, expiry])
    if (client) return client
    void connecting.then((late) => late.release()).catch(() => undefined)
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Run `fn` while holding the advisory lock named `name`, or skip this tick.
 *
 * `pool` is any `pg` `Pool`; the caller's Prisma client (or the same pool) is
 * what `fn` should use for the sweep's own statements.
 */
export const withSweepLock = async <T>(
  pool: SweepLockPool,
  name: string,
  fn: () => Promise<T>,
  options: SweepLockOptions = {},
): Promise<SweepLockOutcome<T>> => {
  const client = await acquireClient(pool, options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS)
  if (!client) {
    console.debug(`[sweep-lock] '${name}' could not get a connection in time, skipping this tick`)
    return { ran: false }
  }

  let held = false
  // Set only when this connection cannot be trusted again. `release(err)`
  // destroys it rather than handing a dead — or still-locked — session to the
  // next borrower.
  let connectionError: Error | undefined

  try {
    const probe = await client.query(LOCK_SQL, [name])
    if (!isLocked(probe.rows[0])) {
      console.debug(`[sweep-lock] '${name}' is held by another instance, skipping this tick`)
      return { ran: false }
    }
    held = true
    return { ran: true, result: await fn() }
  } catch (error) {
    // A body that throws is a sweep failure, not a connection failure, and
    // must not cost the pool a healthy connection. A lock probe that throws
    // never reached the server on a usable socket, so that one is.
    if (!held) connectionError = asError(error)
    throw error
  } finally {
    if (held) {
      try {
        await client.query(UNLOCK_SQL, [name])
      } catch (error) {
        // The unlock is the only thing that ends a session lock on a live
        // connection, so a connection that failed it must not go back to the
        // pool still holding one — the sweep would be locked out of the whole
        // cluster until that connection happened to be recycled. Destroying
        // it drops the backend, and Postgres releases every lock the backend
        // held. Its own failure must not mask the body's error either, which
        // is why it is caught rather than rethrown.
        connectionError = asError(error)
      }
    }
    client.release(connectionError)
  }
}
