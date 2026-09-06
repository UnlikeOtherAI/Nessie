import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { withSweepLock } from '@nessie/db'
import { Pool } from 'pg'

/**
 * `withSweepLock`'s `pg` `Pool` overload, exercised here rather than in
 * `@nessie/db` because this is the package that owns a `Pool`:
 * `PgRealtimeTransport` has one and no Prisma client, and its
 * `realtime_events` retention sweep is the production caller.
 *
 * Real Postgres for the same reason as the Prisma-side suite — a second
 * session refusing the lock is the behaviour, and a fake cannot have it.
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

    const afterRelease = await withSweepLock(second, name, async () => 'third')
    assert.equal(afterRelease.ran, true)
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
