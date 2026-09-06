import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { Client, Pool } from 'pg'
import {
  parseChannelId,
  parseOrganizationId,
  parseRunId,
  parseUserId,
  type WsScope,
} from '@nessie/schemas'

import {
  PgRealtimeTransport,
  type RealtimeNotificationPayload,
} from '../src/realtime.js'

const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

// Two publishers racing on one scope. Enough concurrency that an unlocked
// publisher interleaves an INSERT between another's INSERT and its COMMIT,
// which is the whole defect; small enough to stay inside two 5-client pools.
const PUBLISH_COUNT = 20
const NOTIFICATION_TIMEOUT_MS = 15_000

type Seed = {
  channelId: string
  organizationId: string
  threadId: string
  userId: string
}

/**
 * One LISTEN client on a channel nobody else names, so the arrival order this
 * test asserts is its own publishes and nothing else on `nessie_realtime`.
 */
const startListener = async (
  connectionString: string,
  channel: string,
): Promise<{
  received: RealtimeNotificationPayload[]
  stop: () => Promise<void>
}> => {
  const client = new Client({ connectionString })
  const received: RealtimeNotificationPayload[] = []
  client.on('notification', (notification) => {
    if (!notification.payload) {
      return
    }
    received.push(JSON.parse(notification.payload) as RealtimeNotificationPayload)
  })
  await client.connect()
  await client.query(`LISTEN ${channel}`)

  return {
    received,
    stop: async () => {
      client.removeAllListeners()
      await client.end()
    },
  }
}

const waitForNotifications = async (
  received: RealtimeNotificationPayload[],
  count: number,
): Promise<void> => {
  const deadline = Date.now() + NOTIFICATION_TIMEOUT_MS
  while (received.length < count && Date.now() < deadline) {
    await delay(25)
  }
}

const seedTenant = async (pool: Pool): Promise<Seed> => {
  const seed: Seed = {
    channelId: randomUUID(),
    organizationId: randomUUID(),
    threadId: randomUUID(),
    userId: randomUUID(),
  }
  const projectId = randomUUID()
  const teamId = randomUUID()

  await pool.query(
    `INSERT INTO organizations (id, name, created_at, updated_at)
     VALUES ($1, 'Realtime publish order', now(), now())`,
    [seed.organizationId],
  )
  await pool.query(
    `INSERT INTO projects (id, name, organization_id, created_at, updated_at)
     VALUES ($1, 'Realtime publish order', $2, now(), now())`,
    [projectId, seed.organizationId],
  )
  await pool.query(
    `INSERT INTO teams (id, name, project_id, created_at, updated_at)
     VALUES ($1, 'Realtime publish order', $2, now(), now())`,
    [teamId, projectId],
  )
  await pool.query(
    `INSERT INTO channels (
       id, label, slug, organization_id, project_id, team_id, created_at, updated_at
     )
     VALUES ($1, 'Realtime publish order', $2, $3, $4, $5, now(), now())`,
    [seed.channelId, `realtime-order-${seed.channelId}`, seed.organizationId, projectId, teamId],
  )
  await pool.query(
    `INSERT INTO threads (id, channel_id, created_at, updated_at)
     VALUES ($1, $2, now(), now())`,
    [seed.threadId, seed.channelId],
  )

  return seed
}

// Deleting the organization cascades to the project, team, channel, thread and
// both event tables, so the cleanup names only the seed — never a global
// `DELETE FROM thread_stream_events`, which would take another suite's rows.
const dropTenant = async (pool: Pool, organizationId: string): Promise<void> => {
  await pool.query('DELETE FROM organizations WHERE id = $1', [organizationId])
}

const assertNoLeakedClients = (pool: Pool, label: string): void => {
  assert.equal(pool.waitingCount, 0, `${label}: a publish is still waiting for a client`)
  assert.equal(
    pool.totalCount,
    pool.idleCount,
    `${label}: a pooled client was never released`,
  )
}

/**
 * The ordering defect this locks out: publisher A inserts id 100, publisher B
 * inserts id 101 and commits first, the listener delivers 101, sets the
 * connection watermark to 101 and then drops 100 for good — the client's
 * `Last-Event-ID` has already passed it, so replay (`id > $2`) never returns
 * it either. Insert and NOTIFY inside one transaction is not enough on its
 * own: notifications arrive in *commit* order while ids are handed out at
 * *insert* time. Only the per-scope advisory lock held across both makes the
 * two orders the same, so this asserts arrival order equals persisted id
 * order — not merely that everything eventually arrived.
 */
runIfDatabase(
  'concurrent thread publishes from two transports arrive in strictly increasing sequence',
  async () => {
    const connectionString = process.env.DATABASE_URL!
    const channel = `nessie_realtime_test_${randomUUID().replaceAll('-', '')}`
    const poolA = new Pool({ connectionString, max: 5 })
    const poolB = new Pool({ connectionString, max: 5 })
    const listener = await startListener(connectionString, channel)
    const seed = await seedTenant(poolA)

    try {
      const transportA = new PgRealtimeTransport(poolA, connectionString, channel)
      const transportB = new PgRealtimeTransport(poolB, connectionString, channel)
      const runId = parseRunId(randomUUID())

      await Promise.all(
        Array.from({ length: PUBLISH_COUNT }, (_unused, index) =>
          (index % 2 === 0 ? transportA : transportB).publishSse(
            seed.threadId,
            'stream.delta',
            { content: `chunk-${index}`, runId },
          ),
        ),
      )

      await waitForNotifications(listener.received, PUBLISH_COUNT)
      const sequences = listener.received.map((payload) =>
        payload.kind === 'sse' ? payload.sequence : -1,
      )
      assert.equal(sequences.length, PUBLISH_COUNT, 'every publish must notify exactly once')
      // `thread_stream_events.id` is `int8`, which node-postgres returns as a
      // string. It has to be a number by the time it reaches a notification:
      // the hub assigns it straight into `lastSequence` and compares the next
      // arrival against it, and two strings compare lexicographically, so
      // `'999999' >= '1000000'` would stall the stream at a power of ten.
      for (const sequence of sequences) {
        assert.equal(typeof sequence, 'number', 'a sequence must be a number, not an int8 string')
      }

      for (let index = 1; index < sequences.length; index += 1) {
        assert.ok(
          sequences[index]! > sequences[index - 1]!,
          `notification ${index} arrived out of order: ${sequences[index - 1]} then ${sequences[index]}`,
        )
      }

      const persisted = await poolA.query<{ id: string }>(
        'SELECT id FROM thread_stream_events WHERE thread_id = $1 ORDER BY id ASC',
        [seed.threadId],
      )
      assert.deepEqual(
        persisted.rows.map((row) => Number(row.id)),
        sequences,
        'arrival order must equal persisted id order',
      )
      assertNoLeakedClients(poolA, 'poolA')
      assertNoLeakedClients(poolB, 'poolB')
    } finally {
      await listener.stop()
      await dropTenant(poolA, seed.organizationId)
      await poolA.end()
      await poolB.end()
    }
  },
)

/**
 * The same race on the ws lane, whose watermark (`UserSseConnection.lastEventId`)
 * spans one organization's `realtime_events`, so the lock scope is the
 * organization rather than the thread.
 */
runIfDatabase(
  'concurrent ws publishes from two transports arrive in strictly increasing event id',
  async () => {
    const connectionString = process.env.DATABASE_URL!
    const channel = `nessie_realtime_test_${randomUUID().replaceAll('-', '')}`
    const poolA = new Pool({ connectionString, max: 5 })
    const poolB = new Pool({ connectionString, max: 5 })
    const listener = await startListener(connectionString, channel)
    const seed = await seedTenant(poolA)

    try {
      const transportA = new PgRealtimeTransport(poolA, connectionString, channel)
      const transportB = new PgRealtimeTransport(poolB, connectionString, channel)
      const scopes: WsScope[] = [
        { kind: 'organization', organizationId: parseOrganizationId(seed.organizationId) },
        { kind: 'channel', channelId: parseChannelId(seed.channelId) },
      ]

      await Promise.all(
        Array.from({ length: PUBLISH_COUNT }, (_unused, index) =>
          (index % 2 === 0 ? transportA : transportB).publishWs(scopes, {
            data: { rootMessageId: randomUUID(), threadId: seed.threadId },
            event: 'thread.read',
          }),
        ),
      )

      await waitForNotifications(listener.received, PUBLISH_COUNT)
      const eventIds = listener.received.map((payload) =>
        payload.kind === 'ws' && payload.eventId ? BigInt(payload.eventId) : -1n,
      )
      assert.equal(eventIds.length, PUBLISH_COUNT, 'every publish must notify exactly once')

      for (let index = 1; index < eventIds.length; index += 1) {
        assert.ok(
          eventIds[index]! > eventIds[index - 1]!,
          `notification ${index} arrived out of order: ${eventIds[index - 1]} then ${eventIds[index]}`,
        )
      }

      const persisted = await poolA.query<{ id: string }>(
        'SELECT id FROM realtime_events WHERE organization_id = $1 ORDER BY id ASC',
        [seed.organizationId],
      )
      assert.deepEqual(
        persisted.rows.map((row) => BigInt(row.id)),
        eventIds,
        'arrival order must equal persisted id order',
      )
      assertNoLeakedClients(poolA, 'poolA')
      assertNoLeakedClients(poolB, 'poolB')
    } finally {
      await listener.stop()
      await dropTenant(poolA, seed.organizationId)
      await poolA.end()
      await poolB.end()
    }
  },
)

/**
 * Atomicity. The INSERT and the NOTIFY share one transaction, so a publish
 * that cannot persist must not announce itself either — a listener that saw
 * the event would move a connection watermark past an id no replay can ever
 * return. The rollback also has to give the pooled client back: a publisher
 * that leaks one client per failed publish exhausts the pool and takes the
 * whole realtime lane down with it.
 */
runIfDatabase('a publish whose insert fails notifies nothing and releases its client', async () => {
  const connectionString = process.env.DATABASE_URL!
  const channel = `nessie_realtime_test_${randomUUID().replaceAll('-', '')}`
  const pool = new Pool({ connectionString, max: 5 })
  const listener = await startListener(connectionString, channel)
  const missingThreadId = randomUUID()

  try {
    const transport = new PgRealtimeTransport(pool, connectionString, channel)
    const runId = parseRunId(randomUUID())

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(
        () => transport.publishSse(missingThreadId, 'stream.delta', { content: 'x', runId }),
        /foreign key|violates/i,
      )
    }

    // Long enough for a notification issued outside the transaction to land;
    // the listener is on its own channel, so anything here is this publish.
    await delay(500)
    assert.deepEqual(listener.received, [], 'a rolled-back publish must not notify')

    const persisted = await pool.query(
      'SELECT id FROM thread_stream_events WHERE thread_id = $1',
      [missingThreadId],
    )
    assert.equal(persisted.rowCount, 0, 'a rolled-back publish must not persist')
    assertNoLeakedClients(pool, 'pool')
  } finally {
    await listener.stop()
    await pool.end()
  }
})

/**
 * A user-scoped publication (the incoming-call ring) carries neither an
 * organization nor a channel scope, but the user scope names its own
 * organization. Without that fallback no row is written, and the hub gates the
 * whole user-SSE fan-out on a persisted row — the event would be stored,
 * replayed and delivered to nobody.
 */
runIfDatabase('a user-scoped publish persists under the organization the scope names', async () => {
  const connectionString = process.env.DATABASE_URL!
  const channel = `nessie_realtime_test_${randomUUID().replaceAll('-', '')}`
  const pool = new Pool({ connectionString, max: 5 })
  const listener = await startListener(connectionString, channel)
  const seed = await seedTenant(pool)

  try {
    const transport = new PgRealtimeTransport(pool, connectionString, channel)
    await transport.publishWs(
      [
        {
          kind: 'user',
          organizationId: parseOrganizationId(seed.organizationId),
          userId: parseUserId(seed.userId),
        },
      ],
      { data: { threadId: seed.threadId }, event: 'thread.read' },
    )

    await waitForNotifications(listener.received, 1)
    const [payload] = listener.received
    if (!payload || payload.kind !== 'ws' || !payload.eventId) {
      assert.fail(`expected one ws notification carrying a row id, got ${JSON.stringify(listener.received)}`)
    }

    const persisted = await pool.query<{ id: string; recipient_user_id: string }>(
      'SELECT id, recipient_user_id FROM realtime_events WHERE organization_id = $1',
      [seed.organizationId],
    )
    assert.equal(persisted.rowCount, 1)
    assert.equal(persisted.rows[0]!.recipient_user_id, seed.userId)
    assert.equal(persisted.rows[0]!.id, payload.eventId)
  } finally {
    await listener.stop()
    await dropTenant(pool, seed.organizationId)
    await pool.end()
  }
})
