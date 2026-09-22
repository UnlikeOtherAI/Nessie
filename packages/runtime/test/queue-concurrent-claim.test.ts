import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'

import { PgQueueProvider, type QueueJob } from '../src/queue.js'

// Several subscriptions to one topic inside one process — the worker runs four
// on `executor.command`, because each job there is held for its command's whole
// life. Each subscription is its own claim loop, and the claim is
// `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`, so they must
// run different jobs at the same time and never the same job twice. Only a real
// database can show that: the row lock is the whole mechanism.

const runIfDatabase = process.env['DATABASE_URL'] ? test : test.skip

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

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

runIfDatabase('subscriptions on one topic run different jobs at once, each exactly once', async () => {
  const pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 10 })
  const topic = `test.queue-concurrent-claim.${randomUUID()}`
  const provider = new PgQueueProvider(pool)
  const lanes = 4
  const seeded = await Promise.all(Array.from({ length: lanes }, () => seedPendingJob(pool, topic)))
  const claimed: string[] = []
  const allRunning = deferred()
  const release = deferred()
  let running = 0
  let mostRunning = 0

  const handler = async (job: QueueJob): Promise<void> => {
    claimed.push(job.id)
    running += 1
    mostRunning = Math.max(mostRunning, running)
    if (running === lanes) allRunning.resolve()
    // Held, like an executor command waiting on its machine.
    await release.promise
    running -= 1
  }
  const subscriptions = Array.from({ length: lanes }, () => (
    provider.subscribe(topic, handler, { pollIntervalMs: 25 })
  ))

  try {
    const timedOut = await Promise.race([
      allRunning.promise.then(() => false),
      delay(10_000).then(() => true),
    ])
    assert.equal(timedOut, false, `only ${mostRunning} of ${lanes} jobs ever ran at once`)
    assert.equal(mostRunning, lanes)
    assert.deepEqual([...claimed].sort(), [...seeded].sort(), 'every job was claimed, none twice')

    release.resolve()
    for (let poll = 0; poll < 200; poll += 1) {
      const done = await pool.query<{ count: string }>(
        `SELECT count(*) FROM queue_jobs WHERE topic = $1 AND status = 'done'`,
        [topic],
      )
      if (Number(done.rows[0]?.count) === lanes) break
      await delay(25)
    }
    const rows = await pool.query<{ attempt: number; status: string }>(
      'SELECT status, attempt FROM queue_jobs WHERE topic = $1',
      [topic],
    )
    assert.deepEqual(
      rows.rows.map((row) => `${row.status}:${row.attempt}`),
      Array.from({ length: lanes }, () => 'done:1'),
      'each job was acknowledged on its first and only claim',
    )
    assert.equal(claimed.length, lanes)
  } finally {
    release.resolve()
    for (const subscription of subscriptions) subscription.stop()
    await Promise.all(subscriptions.map((subscription) => subscription.done))
    await pool.query('DELETE FROM queue_jobs WHERE topic = $1', [topic])
    await pool.end()
  }
})
