import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { withSweepLock, type SweepLockClient, type SweepLockPool } from '../src/sweep-lock.js'

/**
 * The helper's own control flow, against a recording pool.
 *
 * What a stub *can* decide is exactly what is asserted here: which statements
 * the helper issues, whether it opens a transaction, and what it hands back to
 * the pool afterwards. Whether a *second database session* is actually refused
 * the lock is a Postgres fact a fake cannot have, so it is proved against real
 * Postgres in `packages/runtime/test/sweep-lock-pool-postgres.test.ts` (the
 * package that owns a `pg` `Pool`) and, at the caller level, in
 * `worker/test/db/registry-sync-lock.test.ts`.
 */

type Recorder = {
  pool: SweepLockPool
  statements: string[]
  releases: (Error | boolean | undefined)[]
}

const recordingPool = (
  options: {
    connect?: () => Promise<SweepLockClient>
    locked?: boolean
    onUnlock?: () => void
  } = {},
): Recorder => {
  const statements: string[] = []
  const releases: (Error | boolean | undefined)[] = []
  const client: SweepLockClient = {
    query: async (sql) => {
      statements.push(sql.trim())
      if (sql.includes('pg_advisory_unlock')) {
        options.onUnlock?.()
        return { rows: [{ unlocked: true }] }
      }
      return { rows: [{ locked: options.locked ?? true }] }
    },
    release: (destroy) => {
      releases.push(destroy)
    },
  }
  return {
    pool: { connect: options.connect ?? (async () => client) },
    releases,
    statements,
  }
}

test('the lock is session-scoped and opens no transaction', async () => {
  const recorder = recordingPool()

  const outcome = await withSweepLock(recorder.pool, 'sweep', async () => 'done')

  assert.equal(outcome.ran, true)
  assert.equal(outcome.ran === true && outcome.result, 'done')
  // A transaction-scoped lock dies with its transaction, and the transaction
  // dies on a timeout the body knows nothing about — the body then runs on
  // beside a second instance that has just been granted the lock. So: no
  // BEGIN, no ROLLBACK, and the session variant of the lock function.
  assert.deepEqual(
    recorder.statements.map((sql) => sql.split('(')[0]),
    ['SELECT pg_try_advisory_lock', 'SELECT pg_advisory_unlock'],
  )
  assert.ok(!recorder.statements.some((sql) => /^(BEGIN|COMMIT|ROLLBACK)/.test(sql)))
  // Explicitly released, because a session lock survives the statement that
  // took it and would otherwise ride the connection back into the pool.
  assert.deepEqual(recorder.releases, [undefined])
})

test('a refused lock skips the tick and gives the connection straight back', async () => {
  const recorder = recordingPool({ locked: false })
  let bodies = 0

  const outcome = await withSweepLock(recorder.pool, 'sweep', async () => {
    bodies += 1
  })

  assert.equal(outcome.ran, false)
  assert.equal(bodies, 0)
  // Nothing to unlock: the probe returned false, so this session holds nothing.
  assert.deepEqual(recorder.statements.length, 1)
  assert.deepEqual(recorder.releases, [undefined])
})

test('a body that throws unlocks and returns a healthy connection to the pool', async () => {
  const recorder = recordingPool()

  await assert.rejects(
    withSweepLock(recorder.pool, 'sweep', async () => {
      throw new Error('sweep body failed')
    }),
    /sweep body failed/,
  )

  assert.ok(recorder.statements.some((sql) => sql.includes('pg_advisory_unlock')))
  // A failing sweep is not a failing connection; destroying it would cost the
  // pool a client on every bad tick.
  assert.deepEqual(recorder.releases, [undefined])
})

test('a connection whose unlock failed is destroyed rather than reused', async () => {
  const recorder = recordingPool({
    onUnlock: () => {
      throw new Error('connection terminated')
    },
  })

  const outcome = await withSweepLock(recorder.pool, 'sweep', async () => 'done')

  // The body still succeeded; the *connection* is what cannot be trusted.
  assert.equal(outcome.ran, true)
  assert.equal(recorder.releases.length, 1)
  const [destroyed] = recorder.releases
  assert.ok(destroyed instanceof Error, 'release must carry the error that broke the connection')
  // Handing it back would return a session that still holds the advisory lock,
  // locking this sweep out of the whole cluster until the pool recycled it.
  assert.match((destroyed as Error).message, /connection terminated/)
})

test('a tick that cannot get a connection in time is a skip, not a throw', async () => {
  // The contract is "a contended tick is skipped". `pool.connect()` on an
  // exhausted pool queues indefinitely, so without a bounded wait every
  // maintenance tick on every replica would hang behind one long-held lock
  // instead of skipping — which is exactly what the Prisma path did in its own
  // way, by exceeding `maxWait` and throwing P2028.
  let released = 0
  const late: SweepLockClient = {
    query: async () => ({ rows: [{ locked: true }] }),
    release: () => {
      released += 1
    },
  }
  let bodies = 0
  const recorder = recordingPool({
    connect: async () => {
      await delay(120)
      return late
    },
  })

  const started = Date.now()
  const outcome = await withSweepLock(
    recorder.pool,
    'sweep',
    async () => {
      bodies += 1
    },
    { acquireTimeoutMs: 20 },
  )

  assert.equal(outcome.ran, false)
  assert.equal(bodies, 0)
  assert.ok(Date.now() - started < 100, 'the skip must not wait for the connection')

  // And the client that arrived late still goes back, or a skipped tick leaks
  // one connection a minute.
  await delay(200)
  assert.equal(released, 1)
})
