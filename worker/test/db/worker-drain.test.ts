import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { Pool } from 'pg'
import { PgQueueProvider, type QueueSubscription } from '@nessie/runtime'

import {
  drainQueueSubscriptions,
  WORKER_DRAIN_TIMEOUT_REASON,
} from '../../src/lifecycle.js'

// The worker's SIGTERM drain, driven through the real `PgQueueProvider` rather
// than a fake subscription, because the two things it got wrong are both about
// the boundary between the drain and the provider:
//
//   1. the per-job `context.signal` aborted only at the DEADLINE, so a long
//      agentic run got no warning that a drain had begun — no window in which
//      to wind down or checkpoint, just the wall; and
//   2. `drainQueueSubscriptions` returned the moment the deadline's nack
//      landed, while the handler was still writing — and `stop()`'s next acts
//      are `pool.end()` and `prisma.$disconnect()`. The handler's final writes
//      (the one that releases the run so a successor can claim it, and the
//      terminal status) then executed against a closing pool and failed, and
//      the successor worker found a run "held by a live executor" that had
//      already exited.
//
// A fake subscription can express neither: the signal is minted by the provider,
// and `done` means "the handler settled" only because the provider's claim loop
// says so. This lives in `test/db/` for the usual reason — it drives a real
// claim loop against the queue table (docs/standards/testing.md).
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

// Every case owns a topic nobody else can name, so its claims, acks and nacks
// are scoped to its own rows on a database it shares. No global count is
// asserted and no global delete is issued.
const uniqueTopic = (): string => `test.worker-drain.${randomUUID()}`

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
// the idempotency-key semantics) and `PgQueueProvider` deliberately exposes only
// the claim side, so seeding is a plain insert: this file is about the drain,
// not about a second write path.
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
  const pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 4 })
  try {
    await run(pool)
  } finally {
    await pool.end()
  }
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

// Let the claim loop unwind before the pool that feeds it is ended, so a failing
// assertion produces its own message rather than a pile of "pool has ended"
// noise from a loop still mid-query.
const quiesce = async (subscription: QueueSubscription | undefined): Promise<void> => {
  if (!subscription) return
  subscription.stop()
  await Promise.race([subscription.done, delay(2_000)])
}

const aborted = (signal: AbortSignal): Promise<void> =>
  signal.aborted
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    })

runDatabaseTest(
  'the in-flight handler hears the drain when it starts, not when it times out',
  async () => {
    await withPool(async (pool) => {
      const topic = uniqueTopic()
      const provider = new PgQueueProvider(pool)
      const jobId = await seedPendingJob(pool, topic)

      const claimed = deferred()
      const release = deferred()
      // The handler's own clock: how long after the drain began did its signal
      // actually abort?
      let drainStartedAt = 0
      let abortedAfterMs: number | null = null
      const subscription = provider.subscribe(
        topic,
        async (_job, { signal }) => {
          claimed.resolve()
          void aborted(signal).then(() => {
            abortedAfterMs = Date.now() - drainStartedAt
          })
          await release.promise
        },
        { pollIntervalMs: 25 },
      )

      try {
        await claimed.promise
        // A deliberately generous deadline: the assertion is that the abort
        // arrives nowhere near it.
        const timeoutMs = 3_000
        drainStartedAt = Date.now()
        const draining = drainQueueSubscriptions([subscription], { timeoutMs })
        await delay(150)

        assert.notEqual(
          abortedAfterMs,
          null,
          'the handler was never told the drain had begun — it only finds out at the deadline',
        )
        assert.ok(
          (abortedAfterMs ?? Infinity) < timeoutMs / 2,
          `the signal aborted ${String(abortedAfterMs)}ms into a ${timeoutMs}ms deadline`,
        )

        // The abort is a warning, not a verdict: a handler that finishes anyway
        // is still acked, and the drain still reports a clean exit.
        release.resolve()
        assert.deepEqual(await draining, { settleTimedOut: false, timedOut: false })
        const row = await readJob(pool, jobId)
        assert.equal(row.status, 'done')
        assert.equal(row.locked_until, null)
      } finally {
        release.resolve()
        await quiesce(subscription)
        await pool.query('DELETE FROM queue_jobs WHERE topic = $1', [topic])
      }
    })
  },
)

runDatabaseTest(
  'the drain waits for an abandoned handler to finish its last write',
  async () => {
    await withPool(async (pool) => {
      const topic = uniqueTopic()
      // A topic nothing subscribes to, so the marker row is only ever touched by
      // the handler's own final write.
      const markerTopic = uniqueTopic()
      const provider = new PgQueueProvider(pool)
      const jobId = await seedPendingJob(pool, topic)
      // Stands in for the run row the real handler releases on its way out: a
      // write issued AFTER it has been told to wind down, through the very pool
      // `stop()` closes next.
      const markerId = await seedPendingJob(pool, markerTopic)

      const claimed = deferred()
      const subscription = provider.subscribe(
        topic,
        async (_job, { signal }) => {
          claimed.resolve()
          await aborted(signal)
          // Winding down takes a moment, and the write lands at the end of it.
          await delay(400)
          await pool.query(
            "UPDATE queue_jobs SET error_message = 'handler-final-write' WHERE id = $1",
            [markerId],
          )
        },
        { pollIntervalMs: 25 },
      )

      try {
        await claimed.promise
        // Short enough that the handler is still winding down when the deadline
        // passes, so it is abandoned and the settle window is what covers it.
        const result = await drainQueueSubscriptions([subscription], {
          settleMs: 5_000,
          timeoutMs: 150,
        })

        // Read immediately: in `stop()` the very next statements are
        // `pool.end()` and `prisma.$disconnect()`, so anything unwritten by now
        // is written against a closing pool and lost.
        assert.equal(
          (await readJob(pool, markerId)).error_message,
          'handler-final-write',
          'the drain handed control back to the teardown before the handler had written',
        )
        assert.equal(result.timedOut, true)
        assert.equal(
          result.settleTimedOut,
          false,
          'the handler had not settled when the settle window was reported closed',
        )
        // The job itself was still released at the deadline, unchanged.
        const row = await readJob(pool, jobId)
        assert.equal(row.status, 'pending')
        assert.equal(row.error_message, WORKER_DRAIN_TIMEOUT_REASON)
      } finally {
        await quiesce(subscription)
        await pool.query('DELETE FROM queue_jobs WHERE topic = ANY($1)', [[topic, markerTopic]])
      }
    })
  },
)

runDatabaseTest(
  'a handler that outlives the deadline is nacked, and its job is claimable at once',
  async () => {
    await withPool(async (pool) => {
      const topic = uniqueTopic()
      const provider = new PgQueueProvider(pool)
      const jobId = await seedPendingJob(pool, topic)

      const claimed = deferred()
      const release = deferred()
      const subscription = provider.subscribe(
        topic,
        async () => {
          claimed.resolve()
          // Ignores the drain signal entirely — the shape of every handler in
          // `worker/src/index.ts` today, and the case the deadline exists for.
          await release.promise
        },
        { pollIntervalMs: 25 },
      )
      let successor: QueueSubscription | undefined
      const successorRelease = deferred()

      try {
        await claimed.promise
        const settleMs = 250
        const timeoutMs = 250
        const started = Date.now()
        const result = await drainQueueSubscriptions([subscription], { settleMs, timeoutMs })
        const elapsed = Date.now() - started

        assert.equal(result.timedOut, true)
        // The teardown does not get control back at the deadline: it waits out
        // the settle window too, because that is the window in which a handler
        // that DOES wind down finishes writing.
        assert.ok(
          elapsed >= timeoutMs + settleMs,
          `the drain handed back after ${elapsed}ms, before the settle window closed`,
        )
        assert.equal(
          result.settleTimedOut,
          true,
          'a handler that never settles was reported as settled',
        )

        const row = await readJob(pool, jobId)
        assert.equal(row.status, 'pending')
        assert.equal(row.locked_until, null)
        assert.equal(row.error_message, WORKER_DRAIN_TIMEOUT_REASON)

        // Immediately claimable: another worker takes it now rather than waiting
        // out the five-minute lock TTL of a process that has already exited.
        const successorClaimed = deferred()
        let successorJobId: string | null = null
        successor = provider.subscribe(
          topic,
          async (job) => {
            successorJobId = job.id
            successorClaimed.resolve()
            await successorRelease.promise
          },
          { pollIntervalMs: 25 },
        )
        await Promise.race([
          successorClaimed.promise,
          delay(5_000).then(() => {
            throw new Error('no successor claimed the released job within 5s')
          }),
        ])
        assert.equal(successorJobId, jobId)
        assert.equal((await readJob(pool, jobId)).attempt, 2)
      } finally {
        release.resolve()
        successorRelease.resolve()
        await quiesce(successor)
        await quiesce(subscription)
        await pool.query('DELETE FROM queue_jobs WHERE topic = $1', [topic])
      }
    })
  },
)
