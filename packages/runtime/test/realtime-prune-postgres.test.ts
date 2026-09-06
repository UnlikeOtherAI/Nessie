import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { parseOrganizationId, parseUserId, type WsScope } from '@nessie/schemas'
import { Pool, type PoolClient } from 'pg'

import { PgRealtimeTransport } from '../src/realtime.js'

/**
 * The `realtime_events` retention sweep, on the realtime hot path.
 *
 * It runs after every durable ws publish, which makes two things properties of
 * the publish path rather than of housekeeping: how often it touches the
 * database at all, and whose clock decides what "past retention" means.
 */
const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

/**
 * The sweep lock's probe. `withOrderedPublish` takes `pg_advisory_xact_lock`,
 * a different function, so this matches the sweep and nothing else.
 */
const LOCK_PROBE = 'pg_try_advisory_lock'
const RETENTION_DELETE = 'DELETE FROM realtime_events'

type Statement = { sql: string; values: unknown[] }

/**
 * A pool that records the sweep's own statements — the lock probe and the
 * retention DELETE — as the transport issues them on borrowed clients.
 */
const recordingPool = (
  connectionString: string,
): { pool: Pool; probes: () => number; deletes: () => Statement[] } => {
  const pool = new Pool({ connectionString, max: 5 })
  const connect = pool.connect.bind(pool)
  // The lock probe runs on a borrowed client; the cadence claim and the
  // retention DELETE run straight on the pool. Both doors are watched.
  const poolQuery = pool.query.bind(pool) as (...args: unknown[]) => unknown
  // Pooled clients are reused, so a client is instrumented once — wrapping on
  // every checkout would count one statement several times over.
  const patched = new WeakSet<PoolClient>()
  const deletes: Statement[] = []
  let probes = 0

  const record = (args: unknown[]): void => {
    const [sql, values] = args
    if (typeof sql !== 'string') return
    if (sql.includes(LOCK_PROBE)) probes += 1
    if (sql.includes(RETENTION_DELETE)) {
      deletes.push({ sql, values: Array.isArray(values) ? values : [] })
    }
  }

  const instrument = (client: PoolClient): PoolClient => {
    // Pooled clients are reused, so a client is instrumented once — wrapping on
    // every checkout would count one statement several times over.
    if (patched.has(client)) return client
    patched.add(client)
    const query = client.query.bind(client) as (...args: unknown[]) => unknown
    Object.assign(client, {
      query: (...args: unknown[]) => {
        record(args)
        return query(...args)
      },
    })
    return client
  }

  Object.assign(pool, {
    // `pool.query` calls `this.connect(callback)` internally while
    // `withSweepLock` awaits `this.connect()`, so both call shapes have to
    // survive the wrapper — a promise-only override deadlocks every
    // `pool.query` on the pool.
    connect: (
      callback?: (error: Error | undefined, client?: PoolClient, done?: () => void) => void,
    ) => {
      const acquired = connect().then(instrument)
      if (typeof callback !== 'function') return acquired
      acquired.then(
        (client) => callback(undefined, client, () => client.release()),
        (error: Error) => callback(error),
      )
      return undefined
    },
    query: (...args: unknown[]) => {
      record(args)
      return poolQuery(...args)
    },
  })

  return { deletes: () => deletes, pool, probes: () => probes }
}

const seedOrganization = async (pool: Pool, label: string): Promise<string> => {
  const organizationId = randomUUID()
  await pool.query(
    `INSERT INTO organizations (id, name, created_at, updated_at)
     VALUES ($1, $2, now(), now())`,
    [organizationId, label],
  )
  return organizationId
}

const scopesFor = (organizationId: string): WsScope[] => [
  { kind: 'organization', organizationId: parseOrganizationId(organizationId) },
  {
    kind: 'user',
    organizationId: parseOrganizationId(organizationId),
    userId: parseUserId(randomUUID()),
  },
]

const publish = (transport: PgRealtimeTransport, scopes: WsScope[]) =>
  transport.publishWs(scopes, {
    data: { rootMessageId: randomUUID(), threadId: randomUUID() },
    event: 'thread.read',
  })

runIfDatabase('the prune asks the database once a minute, not once per publish', async () => {
  // The cadence row is the cluster-wide authority and stays so. But consulting
  // it means borrowing a pooled connection and running an advisory-lock query,
  // and doing that on *every* publish is a new cost and a new stall point on
  // the realtime hot path — on a pool of about ten connections. A cheap
  // in-process pre-filter keeps the database out of the common case.
  const connectionString = process.env.DATABASE_URL!
  const channel = `nessie_realtime_test_${randomUUID().replaceAll('-', '')}`
  const { pool, probes } = recordingPool(connectionString)
  const organizationId = await seedOrganization(pool, 'Realtime prune throttle')

  try {
    const transport = new PgRealtimeTransport(pool, connectionString, channel)
    const scopes = scopesFor(organizationId)

    for (let index = 0; index < 5; index += 1) {
      await publish(transport, scopes)
    }

    assert.equal(
      probes(),
      1,
      'five publishes inside one minute must reach the database once, not five times',
    )

    // And the pool is where it started: nothing is still holding a client.
    assert.equal(pool.waitingCount, 0)
    assert.equal(pool.totalCount, pool.idleCount)
  } finally {
    await pool.query('DELETE FROM organizations WHERE id = $1', [organizationId])
    await pool.end()
  }
})

runIfDatabase('the retention cutoff is the server clock, not the replica clock', async () => {
  // A replica whose clock runs fast used to delete events *younger* than the
  // retention window, because the cutoff was `Date.now() - retention` computed
  // in the process. A client reconnecting inside the window then replayed
  // across a gap it had no way to detect. Retention is 24 h, so with this
  // replica two hours ahead the old cutoff lands at 22 h and takes the
  // 23-hour-old event with it.
  const connectionString = process.env.DATABASE_URL!
  const channel = `nessie_realtime_test_${randomUUID().replaceAll('-', '')}`
  const { pool, deletes } = recordingPool(connectionString)
  const organizationId = await seedOrganization(pool, 'Realtime prune clock')
  const realNow = Date.now

  const insertEvent = async (age: string): Promise<string> => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO realtime_events (organization_id, event_type, payload, created_at)
       VALUES ($1, 'test.retention', '{}'::jsonb, now() - $2::interval)
       RETURNING id`,
      [organizationId, age],
    )
    return inserted.rows[0]!.id
  }
  const stillThere = async (id: string): Promise<boolean> => {
    const row = await pool.query('SELECT 1 FROM realtime_events WHERE id = $1', [id])
    return row.rowCount === 1
  }

  try {
    const outsideWindow = await insertEvent('25 hours')
    const insideWindow = await insertEvent('23 hours')
    const scopes = scopesFor(organizationId)

    // Two hours fast. Scoped as tightly as possible: only the publishes that
    // trigger the prune run under the skewed clock.
    Date.now = () => realNow() + 2 * 60 * 60 * 1000
    try {
      // The cadence is cluster-wide, so a peer suite's publish may have just
      // claimed this minute. Clear it and use a fresh transport (its in-process
      // pre-filter starts open) until this pool has actually issued the
      // retention DELETE — inferring it from a missing row would let a peer's
      // prune stand in for our own and prove nothing.
      for (let attempt = 0; attempt < 5 && deletes().length === 0; attempt += 1) {
        await pool.query('DELETE FROM realtime_prune_state')
        await publish(new PgRealtimeTransport(pool, connectionString, channel), scopes)
      }
    } finally {
      Date.now = realNow
    }

    const [pruned] = deletes()
    assert.ok(pruned, 'the prune never ran, so this proves nothing about its cutoff')
    assert.match(
      pruned.sql,
      /now\(\) - make_interval/,
      'the cutoff must be computed by the server',
    )
    assert.ok(
      !pruned.values.some((value) => value instanceof Date),
      'a replica-side timestamp must not reach the statement',
    )

    assert.equal(await stillThere(outsideWindow), false, 'an event past retention must go')
    assert.equal(
      await stillThere(insideWindow),
      true,
      'an event inside the retention window must survive a replica whose clock runs fast',
    )
  } finally {
    Date.now = realNow
    await pool.query('DELETE FROM organizations WHERE id = $1', [organizationId])
    await pool.end()
  }
})
