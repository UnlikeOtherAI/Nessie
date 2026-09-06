import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'

import {
  LOCK_RENEWAL_FAILED_REASON,
  PgQueueProvider,
  type QueueJob,
  type QueueSubscription,
} from '../src/queue.js'

// The lease race, against a real database, because nothing about it can be
// shown with a stub: worker A claims a job, its handler outlives the lock,
// worker B re-claims the row, and then A finally comes back and tries to
// settle. `attempt` is the claim's identity — `claimNextJob` increments and
// returns it — so A's settle names attempt N while the row carries N+1, and
// the fence is what turns that into zero rows instead of a write.
//
// Unfenced, A's nack flipped a job B was executing back to `pending` for a
// third worker to pick up, and A's acknowledge marked it `done` mid-run.

const runIfDatabase = process.env['DATABASE_URL'] ? test : test.skip

// Every case owns a topic nobody else can name, so its claims and settles are
// scoped to its own rows even though the database is shared.
const uniqueTopic = (): string => `test.queue-settle-fence.${randomUUID()}`

type JobRow = {
  attempt: number
  error_message: string | null
  id: string
  locked_until: Date | null
  status: string
}

const readJob = async (pool: Pool, jobId: string): Promise<JobRow> => {
  const result = await pool.query<JobRow>(
    'SELECT id, status, attempt, error_message, locked_until FROM queue_jobs WHERE id = $1',
    [jobId],
  )
  return result.rows[0]!
}

// The queue has one enqueue door (`enqueueQueueJob` in `@nessie/db`, which owns
// the idempotency-key semantics) and `PgQueueProvider` exposes only the claim
// side, so a plain insert keeps this file testing the settle fence rather than
// a second write path.
const seedPendingJob = async (pool: Pool, topic: string): Promise<string> => {
  const id = randomUUID()
  await pool.query(
    `
      INSERT INTO queue_jobs (id, topic, payload, status, attempt, max_attempts, enqueued_at)
      VALUES ($1, $2, '{}'::jsonb, 'pending', 0, 5, now())
    `,
    [id, topic],
  )
  return id
}

const withPool = async (run: (pool: Pool) => Promise<void>): Promise<void> => {
  const pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 6 })
  try {
    await run(pool)
  } finally {
    await pool.end()
  }
}

const deferred = <T = void>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

type Superseded = {
  claimA: QueueJob
  claimB: QueueJob
  releaseA: () => void
  releaseB: () => void
  settledA: Promise<void>
  stopAll: () => Promise<void>
}

// Drives the race through the provider's own claim path — no hand-built claim
// identities — so what the settle is fenced against is the attempt the database
// actually handed out.
//
// `outcomeA` decides which settle the loser attempts: a handler that resolves
// is acknowledged, one that throws is nacked.
const supersedeClaim = async (
  pool: Pool,
  topic: string,
  outcomeA: 'acknowledge' | 'nack',
): Promise<Superseded> => {
  const jobId = await seedPendingJob(pool, topic)
  // Two instances over one database, each with the production five-minute TTL,
  // so neither one's renewal timer fires inside the test.
  const instanceA = new PgQueueProvider(pool)
  const instanceB = new PgQueueProvider(pool)

  const claimedA = deferred<QueueJob>()
  const releaseA = deferred()
  const subscriptionA = instanceA.subscribe(
    topic,
    async (job) => {
      claimedA.resolve(job)
      await releaseA.promise
      if (outcomeA === 'nack') {
        throw new Error('handler failed after losing the claim')
      }
    },
    { pollIntervalMs: 25 },
  )
  const claimA = await claimedA.promise

  // A's lease runs out while its handler is still going. This is the only step
  // a test has to fake — everything after it is what two real workers do.
  await pool.query(
    "UPDATE queue_jobs SET locked_until = now() - interval '1 minute' WHERE id = $1",
    [jobId],
  )

  const claimedB = deferred<QueueJob>()
  const releaseB = deferred()
  const subscriptionB = instanceB.subscribe(
    topic,
    async (job) => {
      claimedB.resolve(job)
      await releaseB.promise
    },
    { pollIntervalMs: 25 },
  )
  const claimB = await claimedB.promise
  assert.equal(claimB.id, claimA.id, 'the second instance claimed a different row')
  assert.equal(claimB.attempt, claimA.attempt + 1, 'the re-claim did not advance the attempt')

  // Stopping A's loop before it settles keeps it from claiming anything else;
  // the job it holds is settled either way, which is the write under test.
  subscriptionA.stop()

  return {
    claimA,
    claimB,
    releaseA: () => releaseA.resolve(),
    releaseB: () => releaseB.resolve(),
    settledA: subscriptionA.done,
    stopAll: async (): Promise<void> => {
      releaseA.resolve()
      releaseB.resolve()
      subscriptionA.stop()
      subscriptionB.stop()
      await subscriptionA.done
      await subscriptionB.done
    },
  }
}

runIfDatabase('a superseded worker cannot nack the job its successor is running', async () => {
  await withPool(async (pool) => {
    const topic = uniqueTopic()
    const race = await supersedeClaim(pool, topic, 'nack')

    try {
      race.releaseA()
      await race.settledA

      const row = await readJob(pool, race.claimA.id)
      // Unfenced this was `pending` with A's failure in `error_message`, free
      // for a third worker to claim while B was still executing it.
      assert.equal(row.status, 'processing')
      assert.equal(row.attempt, race.claimB.attempt)
      assert.equal(row.error_message, null)
      assert.notEqual(row.locked_until, null)
      assert.ok(
        row.locked_until!.getTime() > Date.now(),
        'the successor no longer holds a live lock on the row',
      )
    } finally {
      await race.stopAll()
      await pool.query('DELETE FROM queue_jobs WHERE topic = $1', [topic])
    }
  })
})

runIfDatabase('a superseded worker cannot acknowledge the job its successor is running', async () => {
  await withPool(async (pool) => {
    const topic = uniqueTopic()
    const race = await supersedeClaim(pool, topic, 'acknowledge')

    try {
      race.releaseA()
      await race.settledA

      const row = await readJob(pool, race.claimA.id)
      // Unfenced this was `done`, so B's own settle later flipped a completed
      // job back to `pending` — or the work simply vanished from the queue
      // while it was still running.
      assert.equal(row.status, 'processing')
      assert.equal(row.attempt, race.claimB.attempt)
      assert.notEqual(row.locked_until, null)
      assert.ok(
        row.locked_until!.getTime() > Date.now(),
        'the successor no longer holds a live lock on the row',
      )
    } finally {
      await race.stopAll()
      await pool.query('DELETE FROM queue_jobs WHERE topic = $1', [topic])
    }
  })
})

runIfDatabase('a refused settle reports itself, and the holder of the claim still settles', async () => {
  await withPool(async (pool) => {
    const topic = uniqueTopic()
    const race = await supersedeClaim(pool, topic, 'acknowledge')

    try {
      // The provider says which it was rather than swallowing it: `false` is
      // "you lost the claim, and your work may be a duplicate", the same signal
      // `renewLock` gives a renewal that matched no row.
      const loser = new PgQueueProvider(pool)
      assert.equal(await loser.nack(race.claimA, 'stale'), false)
      assert.equal(await loser.acknowledge(race.claimA), false)
      // ...and the fence is not a blanket refusal: the instance that holds the
      // claim still settles it.
      assert.equal(await loser.acknowledge(race.claimB), true)

      const row = await readJob(pool, race.claimA.id)
      assert.equal(row.status, 'done')
      assert.equal(row.error_message, null)
    } finally {
      await race.stopAll()
      await pool.query('DELETE FROM queue_jobs WHERE topic = $1', [topic])
    }
  })
})

runIfDatabase('a re-claim aborts the superseded handler instead of letting it finish', async () => {
  await withPool(async (pool) => {
    const topic = uniqueTopic()
    const jobId = await seedPendingJob(pool, topic)
    // A one-second TTL renews once a second, so the two consecutive misses that
    // abort the handler land in about two seconds.
    const instanceA = new PgQueueProvider(pool, { lockTtlSeconds: 1 })
    const instanceB = new PgQueueProvider(pool)

    const claimedA = deferred<QueueJob>()
    let abortReason: unknown
    let subscriptionA: QueueSubscription | undefined
    subscriptionA = instanceA.subscribe(
      topic,
      async (job, { signal }) => {
        claimedA.resolve(job)
        // Bounded, so a renewal that never notices the re-claim fails the
        // assertion instead of hanging the suite. The bound is cancelled on the
        // way out: an uncancelled one holds the event loop open for its whole
        // duration after the case has already passed.
        const bound = new AbortController()
        await Promise.race([
          new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true })
          }),
          delay(10_000, undefined, { signal: bound.signal }).catch(() => undefined),
        ])
        bound.abort()
        abortReason = signal.aborted ? signal.reason : undefined
        subscriptionA?.stop()
      },
      { pollIntervalMs: 25 },
    )
    await claimedA.promise

    const claimedB = deferred<QueueJob>()
    const releaseB = deferred()
    const subscriptionB = instanceB.subscribe(
      topic,
      async (job) => {
        claimedB.resolve(job)
        await releaseB.promise
      },
      { pollIntervalMs: 25 },
    )

    try {
      // A is still renewing its one-second lease, so keep expiring it until B
      // wins the row. Once B holds it, A's renewals name the wrong attempt.
      const expiring = setInterval(() => {
        void pool.query(
          "UPDATE queue_jobs SET locked_until = now() - interval '1 minute' WHERE id = $1",
          [jobId],
        ).catch(() => undefined)
      }, 50)
      expiring.unref()
      const claimB = await claimedB.promise
      clearInterval(expiring)

      await subscriptionA.done

      // A status-only fence left the loser renewing the row happily — extending
      // its successor's lock, never learning it had been superseded, and
      // running the job to completion beside it.
      assert.equal(
        (abortReason as Error | undefined)?.message,
        LOCK_RENEWAL_FAILED_REASON,
        'the superseded handler was never told it had lost the claim',
      )
      const row = await readJob(pool, jobId)
      assert.equal(row.status, 'processing')
      assert.equal(row.attempt, claimB.attempt)
      assert.equal(row.error_message, null)
    } finally {
      releaseB.resolve()
      subscriptionA.stop()
      subscriptionB.stop()
      await subscriptionA.done
      await subscriptionB.done
      await pool.query('DELETE FROM queue_jobs WHERE topic = $1', [topic])
    }
  })
})
