import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'

import {
  expireDeadQueueJobs,
  LOCK_EXPIRED_AT_MAX_ATTEMPTS_REASON,
  LOCK_RENEWAL_FAILED_REASON,
  PgQueueProvider,
  type QueueSubscription,
} from '../src/queue.js'

const runIfDatabase = process.env['DATABASE_URL'] ? test : test.skip

// Every case owns a topic nobody else can name, so its claims, acks and nacks
// are scoped to its own rows even though the database is shared — no global
// count is asserted and no global delete is issued.
const uniqueTopic = (): string => `test.queue-drain.${randomUUID()}`

type JobRow = {
  attempt: number
  error_message: string | null
  id: string
  locked_until: Date | null
  status: string
}

const readJobs = async (pool: Pool, topic: string): Promise<JobRow[]> => {
  const result = await pool.query<JobRow>(
    'SELECT id, status, attempt, error_message, locked_until FROM queue_jobs '
    + 'WHERE topic = $1 ORDER BY enqueued_at',
    [topic],
  )
  return result.rows
}

// Seeding a pending job is the test's own business, not the provider's: the
// queue has one enqueue door (`enqueueQueueJob` in `@nessie/db`, which owns the
// idempotency-key semantics), and `PgQueueProvider` deliberately exposes only
// the claim side. A plain insert here keeps this file testing the drain rather
// than a second write path.
const seedPendingJob = async (
  pool: Pool,
  topic: string,
  payload: Record<string, unknown>,
): Promise<string> => {
  const id = randomUUID()
  await pool.query(
    `
      INSERT INTO queue_jobs (id, topic, payload, status, attempt, max_attempts, enqueued_at)
      VALUES ($1, $2, $3::jsonb, 'pending', 0, 5, now())
    `,
    [id, topic, JSON.stringify(payload)],
  )
  return id
}

// A row the claim loop could never have produced on its own inside a test: an
// abandoned `processing` job whose lock has already expired.
const seedStuckJob = async (
  pool: Pool,
  topic: string,
  input: { attempt: number; maxAttempts: number; olderBySeconds: number },
): Promise<string> => {
  const id = randomUUID()
  await pool.query(
    `
      INSERT INTO queue_jobs (
        id, topic, payload, status, attempt, max_attempts,
        locked_until, enqueued_at, started_at
      )
      VALUES (
        $1, $2, '{}'::jsonb, 'processing', $3, $4,
        now() - interval '1 minute',
        now() - make_interval(secs => $5),
        now() - interval '10 minutes'
      )
    `,
    [id, topic, input.attempt, input.maxAttempts, input.olderBySeconds],
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

const deferred = <T = void>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

runIfDatabase('a draining subscription claims nothing more', async () => {
  await withPool(async (pool) => {
    const topic = uniqueTopic()
    const provider = new PgQueueProvider(pool)
    await seedPendingJob(pool, topic, { seq: 1 })
    await seedPendingJob(pool, topic, { seq: 2 })

    const claimed = deferred()
    const release = deferred()
    let handled = 0
    const subscription = provider.subscribe(
      topic,
      async () => {
        handled += 1
        claimed.resolve()
        await release.promise
      },
      { pollIntervalMs: 25 },
    )

    try {
      await claimed.promise
      subscription.stop()
      release.resolve()
      await subscription.done

      assert.equal(handled, 1, 'the drain let a second job be claimed')
      const rows = await readJobs(pool, topic)
      const done = rows.filter((row) => row.status === 'done')
      const pending = rows.filter((row) => row.status === 'pending')
      assert.equal(done.length, 1)
      assert.equal(pending.length, 1)
      // Untouched: never claimed, so never attempted.
      assert.equal(pending[0]!.attempt, 0)
    } finally {
      release.resolve()
      subscription.stop()
      await pool.query('DELETE FROM queue_jobs WHERE topic = $1', [topic])
    }
  })
})

runIfDatabase('a handler that completes during a drain is acked', async () => {
  await withPool(async (pool) => {
    const topic = uniqueTopic()
    const provider = new PgQueueProvider(pool)
    const jobId = await seedPendingJob(pool, topic, { seq: 1 })

    const claimed = deferred()
    const release = deferred()
    const subscription = provider.subscribe(
      topic,
      async () => {
        claimed.resolve()
        await release.promise
      },
      { pollIntervalMs: 25 },
    )

    try {
      await claimed.promise
      subscription.stop()
      release.resolve()
      await subscription.done

      const rows = await readJobs(pool, topic)
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.id, jobId)
      // The abort path used to return here without ack or nack, leaving the row
      // `processing` with a live lock until the five-minute TTL burnt down.
      assert.equal(rows[0]!.status, 'done')
      assert.equal(rows[0]!.locked_until, null)
    } finally {
      release.resolve()
      subscription.stop()
      await pool.query('DELETE FROM queue_jobs WHERE topic = $1', [topic])
    }
  })
})

runIfDatabase('two consecutive lock-renewal failures abort the handler and nack the job', async () => {
  await withPool(async (pool) => {
    const topic = uniqueTopic()
    // A one-second TTL renews once a second, so two consecutive misses land in
    // about two seconds instead of the production three-and-a-bit minutes.
    const provider = new PgQueueProvider(pool, { lockTtlSeconds: 1 })
    const jobId = await seedPendingJob(pool, topic, { seq: 1 })

    const claimed = deferred()
    let sawAbort = false
    let subscription: QueueSubscription | undefined
    subscription = provider.subscribe(
      topic,
      async (_job, { signal }) => {
        claimed.resolve()
        // Bounded, so a renewal policy that only logs (the old behaviour) fails
        // the `sawAbort` assertion instead of hanging the suite.
        await Promise.race([
          new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true })
          }),
          delay(6_000),
        ])
        sawAbort = signal.aborted
        // Stop from inside the handler so the loop cannot re-claim the row the
        // nack is about to make pending again, and the assertions are stable.
        subscription?.stop()
      },
      { pollIntervalMs: 25 },
    )

    try {
      await claimed.promise
      // Take the claim out from under the handler the way a competing worker or
      // a dead-letter sweep would: the renewal UPDATE now matches no row.
      await pool.query(
        "UPDATE queue_jobs SET status = 'pending' WHERE id = $1",
        [jobId],
      )

      await subscription.done

      assert.equal(sawAbort, true, 'the handler was never aborted')
      const rows = await readJobs(pool, topic)
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.error_message, LOCK_RENEWAL_FAILED_REASON)
      // Re-claimable immediately rather than after the lock TTL expires.
      assert.equal(rows[0]!.status, 'pending')
      assert.equal(rows[0]!.locked_until, null)
    } finally {
      subscription.stop()
      await pool.query('DELETE FROM queue_jobs WHERE topic = $1', [topic])
    }
  })
})

runIfDatabase('the claim timeout arm skips a job already at max_attempts', async () => {
  await withPool(async (pool) => {
    const topic = uniqueTopic()
    const provider = new PgQueueProvider(pool)
    // Older, so `ORDER BY enqueued_at` offers it first: if the guard is missing
    // this is the row that gets claimed.
    const maxedOut = await seedStuckJob(pool, topic, {
      attempt: 3,
      maxAttempts: 3,
      olderBySeconds: 600,
    })
    const retryable = await seedStuckJob(pool, topic, {
      attempt: 1,
      maxAttempts: 3,
      olderBySeconds: 300,
    })

    const handledIds: string[] = []
    let subscription: QueueSubscription | undefined
    subscription = provider.subscribe(
      topic,
      async (job) => {
        handledIds.push(job.id)
        subscription?.stop()
      },
      { pollIntervalMs: 25 },
    )

    try {
      await subscription.done

      assert.deepEqual(handledIds, [retryable])
      const rows = await readJobs(pool, topic)
      const maxedRow = rows.find((row) => row.id === maxedOut)!
      // Never re-claimed: the crash loop stops here instead of migrating to the
      // next instance every five minutes forever.
      assert.equal(maxedRow.status, 'processing')
      assert.equal(maxedRow.attempt, 3)
      assert.equal(rows.find((row) => row.id === retryable)!.status, 'done')
    } finally {
      subscription.stop()
      await pool.query('DELETE FROM queue_jobs WHERE topic = $1', [topic])
    }
  })
})

runIfDatabase('expireDeadQueueJobs dead-letters the jobs the claim now refuses', async () => {
  await withPool(async (pool) => {
    const topic = uniqueTopic()
    const maxedOut = await seedStuckJob(pool, topic, {
      attempt: 3,
      maxAttempts: 3,
      olderBySeconds: 600,
    })
    const retryable = await seedStuckJob(pool, topic, {
      attempt: 1,
      maxAttempts: 3,
      olderBySeconds: 300,
    })

    try {
      // The sweep is set-based and deliberately unscoped — it is the production
      // shape, and the only rows it can reach are ones no claim would take.
      // Assert this seed's outcome, never the global count it returns.
      await expireDeadQueueJobs(pool)

      const rows = await readJobs(pool, topic)
      const maxedRow = rows.find((row) => row.id === maxedOut)!
      assert.equal(maxedRow.status, 'dead')
      assert.equal(maxedRow.error_message, LOCK_EXPIRED_AT_MAX_ATTEMPTS_REASON)
      assert.equal(maxedRow.locked_until, null)
      // Still re-claimable, so the sweep is not a blanket expiry.
      const retryableRow = rows.find((row) => row.id === retryable)!
      assert.equal(retryableRow.status, 'processing')
      assert.equal(retryableRow.error_message, null)
    } finally {
      await pool.query('DELETE FROM queue_jobs WHERE topic = $1', [topic])
    }
  })
})

// `abandon()`'s reason on the worker's drain deadline. Spelled out rather than
// imported: the constant lives in `@nessie/worker`, which depends on this
// package and not the other way round.
const DRAIN_DEADLINE_REASON = 'worker_drain_timeout'

runIfDatabase('a handler completing as the deadline fires applies exactly one settle write', async () => {
  await withPool(async (pool) => {
    const topic = uniqueTopic()
    const provider = new PgQueueProvider(pool)
    const jobId = await seedPendingJob(pool, topic, { seq: 1 })

    // Every terminal statement this subscription issues, in order. The
    // acknowledge is held open at its entry so the drain deadline lands exactly
    // where the race lived: after the handler resolved and before its ack
    // reached the database. Both statements go out on different pooled
    // connections with no ordering between them, so "the nack lost the race" is
    // not a defence — the second one must never be issued at all.
    const applied: string[] = []
    const ackEntered = deferred()
    const releaseAck = deferred()
    const realAcknowledge = provider.acknowledge.bind(provider)
    const realNack = provider.nack.bind(provider)
    provider.acknowledge = async (id: string): Promise<void> => {
      applied.push('acknowledge')
      ackEntered.resolve()
      await releaseAck.promise
      await realAcknowledge(id)
    }
    provider.nack = async (id: string, reason?: string): Promise<void> => {
      applied.push('nack')
      await realNack(id, reason)
    }

    const claimed = deferred()
    const release = deferred()
    const subscription = provider.subscribe(
      topic,
      async () => {
        claimed.resolve()
        await release.promise
      },
      { pollIntervalMs: 25 },
    )

    try {
      await claimed.promise
      subscription.stop()
      release.resolve()
      // The handler has resolved and its acknowledge is in flight.
      await ackEntered.promise
      // ...and only now does the drain run out of patience.
      await subscription.abandon(DRAIN_DEADLINE_REASON)
      releaseAck.resolve()
      await subscription.done

      // The invariant: exactly one of acknowledge and nack is ever applied to a
      // job. Without the single-writer gate the nack went out too, and whichever
      // committed last decided the row — a completed job back to `pending` for a
      // second worker to run, or a row the successor already held flipped to
      // `done` mid-run.
      assert.deepEqual(applied, ['acknowledge'])
      const rows = await readJobs(pool, topic)
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.id, jobId)
      assert.equal(rows[0]!.status, 'done')
      // The nack is the only thing that writes this column, so a null here says
      // no nack was applied whatever order the two statements committed in.
      assert.equal(rows[0]!.error_message, null)
      assert.equal(rows[0]!.locked_until, null)
    } finally {
      release.resolve()
      releaseAck.resolve()
      subscription.stop()
      await pool.query('DELETE FROM queue_jobs WHERE topic = $1', [topic])
    }
  })
})

runIfDatabase('a job abandoned on the deadline is nacked once and its straggler never acks', async () => {
  await withPool(async (pool) => {
    const topic = uniqueTopic()
    const provider = new PgQueueProvider(pool)
    const jobId = await seedPendingJob(pool, topic, { seq: 1 })

    const applied: string[] = []
    const realAcknowledge = provider.acknowledge.bind(provider)
    const realNack = provider.nack.bind(provider)
    provider.acknowledge = async (id: string): Promise<void> => {
      applied.push('acknowledge')
      await realAcknowledge(id)
    }
    provider.nack = async (id: string, reason?: string): Promise<void> => {
      applied.push('nack')
      await realNack(id, reason)
    }

    const claimed = deferred()
    const release = deferred()
    const subscription = provider.subscribe(
      topic,
      async () => {
        claimed.resolve()
        await release.promise
      },
      { pollIntervalMs: 25 },
    )

    try {
      await claimed.promise
      // The deadline fires with the handler still running: the row is released
      // now rather than after its five-minute lock burns down.
      await subscription.abandon(DRAIN_DEADLINE_REASON)
      // The straggler falls out inside its settle window. It ran to completion,
      // but a successor may already hold the row, so its ack is not its to
      // issue — the other half of the same single-writer invariant.
      release.resolve()
      await subscription.done

      assert.deepEqual(applied, ['nack'])
      const rows = await readJobs(pool, topic)
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.id, jobId)
      assert.equal(rows[0]!.status, 'pending')
      assert.equal(rows[0]!.error_message, DRAIN_DEADLINE_REASON)
      assert.equal(rows[0]!.locked_until, null)
    } finally {
      release.resolve()
      subscription.stop()
      await pool.query('DELETE FROM queue_jobs WHERE topic = $1', [topic])
    }
  })
})
