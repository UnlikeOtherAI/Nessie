import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { withSweepLock } from '@nessie/db'
import { Pool } from 'pg'

/**
 * `withSweepLock` against real Postgres, exercised here rather than in
 * `@nessie/db` because this is the package that owns a `Pool`:
 * `PgRealtimeTransport` has one, and its `realtime_events` retention sweep is
 * the production caller. (`@nessie/db`'s own suite covers the helper's control
 * flow against a recording pool — which statements it issues and what it hands
 * back — the parts a fake can honestly decide.)
 *
 * An advisory lock has no honest stub: the whole point is that a *second*
 * database session cannot take it, and a fake would be asserting against the
 * fake. So these use two independent pools standing in for two replicas.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const gate = (): { wait: Promise<void>; open: () => void } => {
  let open: () => void = () => undefined
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, wait }
}

runDatabaseTest('a pool-held lock skips the second instance and releases its client', async () => {
  const first = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  const second = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  const name = `sweep-lock-pool-test:${randomUUID()}`
  const held = gate()
  const running = gate()
  let bodies = 0

  try {
    const holder = withSweepLock(first, name, async () => {
      bodies += 1
      running.open()
      await held.wait
      return 'first'
    })
    await running.wait
    // One client is out of the pool for exactly as long as the lock is held.
    assert.equal(first.totalCount - first.idleCount, 1)

    const contender = await withSweepLock(second, name, async () => {
      bodies += 1
      return 'second'
    })
    assert.equal(contender.ran, false)
    assert.equal(bodies, 1)
    // The loser's client goes straight back, or a skipped tick leaks a
    // connection every minute until the pool is exhausted.
    assert.equal(second.totalCount - second.idleCount, 0)

    held.open()
    const outcome = await holder
    assert.equal(outcome.ran, true)
    assert.equal(outcome.ran === true && outcome.result, 'first')
    assert.equal(first.totalCount - first.idleCount, 0)

    // Session-scoped, so the lock ends when the body does — released by the
    // helper's own `pg_advisory_unlock`, not by a transaction the body never
    // knew about. The next tick runs rather than being wedged out by a session
    // lock nobody remembered to release.
    const afterRelease = await withSweepLock(second, name, async () => 'third')
    assert.equal(afterRelease.ran, true)
    assert.equal(afterRelease.ran === true && afterRelease.result, 'third')
  } finally {
    held.open()
    await first.end()
    await second.end()
  }
})

runDatabaseTest('different names do not contend, and a throwing body releases', async () => {
  const first = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  const second = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  const suffix = randomUUID()
  const held = gate()
  const running = gate()

  try {
    const holder = withSweepLock(first, `sweep-lock-a:${suffix}`, async () => {
      running.open()
      await held.wait
      return 'a'
    })
    await running.wait

    // Hashed per name, so one slow sweep cannot starve an unrelated one.
    const other = await withSweepLock(second, `sweep-lock-b:${suffix}`, async () => 'b')
    assert.equal(other.ran, true)

    held.open()
    await holder

    await assert.rejects(
      withSweepLock(first, `sweep-lock-a:${suffix}`, async () => {
        throw new Error('sweep body failed')
      }),
      /sweep body failed/,
    )
    // The lock has to be released by the failure too, or one bad tick locks the
    // sweep out of the cluster until the process restarts.
    const afterThrow = await withSweepLock(second, `sweep-lock-a:${suffix}`, async () => 'ok')
    assert.equal(afterThrow.ran, true)
    assert.equal(first.totalCount - first.idleCount, 0)
  } finally {
    held.open()
    await first.end()
    await second.end()
  }
})

runDatabaseTest('a throwing body releases both the lock and the pooled client', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  const other = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  const name = `sweep-lock-pool-test:${randomUUID()}`

  try {
    await assert.rejects(
      withSweepLock(pool, name, async () => {
        throw new Error('sweep body failed')
      }),
      /sweep body failed/,
    )
    assert.equal(pool.totalCount - pool.idleCount, 0)

    const next = await withSweepLock(other, name, async () => 'ok')
    assert.equal(next.ran, true)
  } finally {
    await pool.end()
    await other.end()
  }
})

runDatabaseTest('a tick that cannot get a client skips instead of queueing behind one', async () => {
  // A pool of one, with its only client held by a running sweep. The contract
  // says a contended tick is a *skip*; `pool.connect()` would otherwise queue
  // this behind the holder for the body's whole duration, which on a
  // once-a-minute sweep is how a long-held lock turns every replica's
  // maintenance timer into a growing queue of pending acquires.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  const name = `sweep-lock-pool-test:${randomUUID()}`
  const held = gate()
  const running = gate()

  try {
    const holder = withSweepLock(pool, name, async () => {
      running.open()
      await held.wait
      return 'first'
    })
    await running.wait

    const started = Date.now()
    const contender = await withSweepLock(
      pool,
      name,
      async () => 'second',
      { acquireTimeoutMs: 100 },
    )
    assert.equal(contender.ran, false)
    assert.ok(Date.now() - started < 1_000, 'the skip must not wait on the holder')

    held.open()
    await holder
    // The abandoned acquire is handed back rather than parked on the pool.
    await delay(50)
    assert.equal(pool.waitingCount, 0)
    assert.equal(pool.totalCount, pool.idleCount)
  } finally {
    held.open()
    await pool.end()
  }
})
