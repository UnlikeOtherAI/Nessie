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
  resolveRealtimeNotification,
  type RealtimeNotificationEnvelope,
} from '../src/realtime.js'
import { publishThreadStreamEvent, publishWsEvent } from '../src/realtime-publish.js'

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
  received: RealtimeNotificationEnvelope[]
  stop: () => Promise<void>
}> => {
  const client = new Client({ connectionString })
  const received: RealtimeNotificationEnvelope[] = []
  client.on('notification', (notification) => {
    if (!notification.payload) {
      return
    }
    received.push(JSON.parse(notification.payload) as RealtimeNotificationEnvelope)
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
  received: RealtimeNotificationEnvelope[],
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

/**
 * Size. Postgres caps a NOTIFY payload at 8000 bytes, and `stream.done` carries
 * the whole assistant reply, which has no bound at all (horizontal-scaling
 * audit 2.7). Once the INSERT and the NOTIFY share a transaction, the raise the
 * oversized notify produces would roll the row back with it — turning an event
 * that used to be merely *late* (the row was already committed, so the client's
 * next reconnect replayed it) into one that never existed, and failing the
 * caller's publish besides. So the publisher measures the payload first and
 * announces an oversized one by row id alone: the row commits, the notification
 * stays well inside the cap, and the listener reads the event back whole.
 */
runIfDatabase('an oversized payload still commits its row and is announced by id', async () => {
  const connectionString = process.env.DATABASE_URL!
  const channel = `nessie_realtime_test_${randomUUID().replaceAll('-', '')}`
  const pool = new Pool({ connectionString, max: 5 })
  const listener = await startListener(connectionString, channel)
  const seed = await seedTenant(pool)
  // Comfortably past the cap, and no larger than a long model answer really is.
  const content = 'x'.repeat(20_000)

  try {
    const transport = new PgRealtimeTransport(pool, connectionString, channel)
    const runId = parseRunId(randomUUID())

    // Nothing here may throw: the caller's operation must not fail because its
    // announcement was too big to fit down a notification channel.
    const record = await transport.publishSse(seed.threadId, 'stream.delta', { content, runId })

    const persisted = await pool.query<{ data: { content: string }; id: string }>(
      'SELECT id, data FROM thread_stream_events WHERE thread_id = $1',
      [seed.threadId],
    )
    assert.equal(persisted.rowCount, 1, 'an oversized payload must still commit its row')
    assert.equal(persisted.rows[0]!.data.content, content, 'the row must hold the whole payload')
    assert.equal(Number(persisted.rows[0]!.id), record.sequence)

    await waitForNotifications(listener.received, 1)
    const [envelope] = listener.received
    assert.equal(listener.received.length, 1, 'an oversized payload must still notify exactly once')
    if (!envelope || envelope.kind !== 'sse-ref') {
      assert.fail(`expected an id-only notification, got ${JSON.stringify(envelope).slice(0, 200)}`)
    }
    assert.equal(envelope.ref.sequence, record.sequence)
    assert.ok(
      Buffer.byteLength(JSON.stringify(envelope), 'utf8') < 8_000,
      'the id-only notification must fit inside the NOTIFY cap',
    )

    // Recoverable: the listener side turns the id back into the whole event
    // before anything above the transport sees it.
    const resolved = await resolveRealtimeNotification(pool, envelope)
    if (!resolved || resolved.kind !== 'sse') {
      assert.fail(`the id-only notification must resolve to its row, got ${JSON.stringify(resolved)}`)
    }
    assert.equal(resolved.sequence, record.sequence)
    assert.equal((resolved.data as { content: string }).content, content)
    assertNoLeakedClients(pool, 'pool')
  } finally {
    await listener.stop()
    await dropTenant(pool, seed.organizationId)
    await pool.end()
  }
})

/**
 * The rollback can fail too — the server refuses the command, a blip lands mid
 * statement — and node-postgres does not roll a transaction back when a client
 * is released. A plain `release()` would then hand the next borrower a client
 * still inside this publish's transaction, still holding this scope's advisory
 * lock, and that borrower's statements would run in it and be discarded by
 * whatever rolls back next. Releasing *with* an error makes the pool destroy
 * the connection instead. No database here: the assertion is which argument
 * `release` receives, and only a fake client can fail a ROLLBACK on demand.
 */
test('a publish whose rollback fails destroys the pooled client instead of reusing it', async () => {
  const insertFailure = new Error('insert failed')
  const rollbackFailure = new Error('rollback failed')
  const released: unknown[] = []
  const statements: string[] = []

  const client = {
    query: async (text: string) => {
      statements.push(text.trim().split('\n')[0]!.trim())
      if (text.includes('INSERT INTO thread_stream_events')) {
        throw insertFailure
      }
      if (text.trim() === 'ROLLBACK') {
        throw rollbackFailure
      }
      return { rows: [] }
    },
    release: (reason?: unknown) => {
      released.push(reason)
    },
  }
  const pool = { connect: async () => client } as unknown as Pool

  await assert.rejects(
    () =>
      publishThreadStreamEvent(pool, 'nessie_realtime_test', {
        data: { content: 'x', runId: parseRunId(randomUUID()) },
        event: 'stream.delta',
        threadId: randomUUID(),
      }),
    (error) => error === insertFailure,
    'the original failure must reach the caller, not the rollback failure',
  )

  assert.ok(statements.includes('ROLLBACK'), 'a failed publish must attempt a rollback')
  assert.deepEqual(
    released,
    [rollbackFailure],
    'a client whose ROLLBACK failed must be released with an error so the pool destroys it',
  )
})

/**
 * Exactly the reads the build on `main` performs on a notification whose `kind`
 * it does not recognise, in the order it performs them — transcribed from
 * `api/src/realtime/notification-delivery.ts` rather than imported, because the
 * subject is the build that is *already deployed*: it cannot be changed, and
 * this branch's copy of that file no longer looks like this.
 *
 * Every read here is unchecked in that build, and it runs them inside an
 * unawaited promise (`void onNotification(payload)`), so anything this throws
 * is an unhandled rejection on a live replica — which ends the process on Node
 * 22. Blue-green means an old replica is listening on the same channel for the
 * whole length of a swap, so a new replica publishing one long assistant reply
 * would kill it, and the admin always holds a WebSocket connection.
 */
const readAsPreviousBuild = (notification: Record<string, unknown>): void => {
  if (notification.kind === 'sse') {
    return
  }

  // `message` is dereferenced with no guard of its own whenever `eventId` is a
  // string — three times, to build the replay event.
  if (typeof notification.eventId === 'string' && BigInt(notification.eventId) > 0n) {
    const message = notification.message as { event: string; ts: string }
    void new Date(message.ts)
    void message.event
    void JSON.stringify(message)
  }

  // The first statement of that build's `shouldDeliverWsNotification`, reached
  // once per WebSocket connection whether or not a replay event was built.
  const scopes = notification.scopes as { kind: string }[]
  void scopes.filter((scope) => scope.kind === 'channel')
  void scopes.filter((scope) => scope.kind === 'user')
  void scopes.filter((scope) => scope.kind === 'dashboard')
}

const capturingPool = (rows: Record<string, unknown>[]) => {
  const notified: string[] = []
  const client = {
    query: async (text: string, values?: unknown[]) => {
      if (text.includes('pg_notify')) {
        notified.push(String(values?.[1]))
        return { rows: [] }
      }
      if (text.includes('INSERT INTO')) {
        return { rows }
      }
      return { rows: [] }
    },
    release: () => undefined,
  }

  return {
    notified,
    pool: {
      connect: async () => client,
      query: async () => {
        throw new Error('the publish must resolve its organization without a pool query')
      },
    } as unknown as Pool,
  }
}

/**
 * The compact form has to be *inert* to the previous build rather than rely on
 * it being tolerant. Both envelopes therefore keep every field that build
 * dereferences off their top level — `eventId`, and so `message` — and carry an
 * empty `scopes` for the one it dereferences unconditionally. Delete either and
 * a rolling deploy takes down every replica still running the old image.
 */
test('a compact ref envelope is inert to a replica running the previous build', async () => {
  const organizationId = parseOrganizationId(randomUUID())
  const channelId = parseChannelId(randomUUID())
  const threadId = randomUUID()
  const scopes: WsScope[] = [
    { kind: 'organization', organizationId },
    { kind: 'channel', channelId },
  ]
  // Past the 7000-byte notify budget, so both publishers take the compact path.
  const oversized = 'x'.repeat(20_000)

  const sse = capturingPool([
    {
      id: '4242',
      thread_id: threadId,
      event_name: 'stream.delta',
      data: { content: oversized, runId: parseRunId(randomUUID()) },
      created_at: new Date(),
    },
  ])
  await publishThreadStreamEvent(sse.pool, 'nessie_realtime_test', {
    data: { content: oversized, runId: parseRunId(randomUUID()) },
    event: 'stream.delta',
    threadId,
  })

  const message = {
    data: { content: oversized },
    event: 'message.created',
    ts: new Date().toISOString(),
    type: 'event' as const,
  }
  const ws = capturingPool([
    {
      id: '99',
      organization_id: organizationId,
      channel_id: channelId,
      recipient_user_id: null,
      event_type: message.event,
      payload: message,
      created_at: new Date(),
    },
  ])
  await publishWsEvent(ws.pool, 'nessie_realtime_test', { message, scopes })

  assert.equal(sse.notified.length, 1)
  assert.equal(ws.notified.length, 1)

  for (const [label, body] of [
    ['sse-ref', sse.notified[0]!],
    ['ws-ref', ws.notified[0]!],
  ] as const) {
    const envelope = JSON.parse(body) as Record<string, unknown>
    assert.equal(envelope.kind, label)
    assert.ok(
      Array.isArray(envelope.scopes),
      `${label}: the previous build filters \`scopes\` unchecked, so it must be an array`,
    )
    assert.equal(
      (envelope.scopes as unknown[]).length,
      0,
      `${label}: a non-empty \`scopes\` would make the previous build try to deliver an envelope it cannot read`,
    )
    assert.equal(
      envelope.eventId,
      undefined,
      `${label}: a top-level \`eventId\` sends the previous build straight into \`message\`, which is not here`,
    )
    assert.equal(envelope.message, undefined, `${label}: the compact form carries no payload`)
    assert.doesNotThrow(
      () => readAsPreviousBuild(envelope),
      `${label}: the previous build must survive this envelope`,
    )
  }
})

/**
 * The other half of the same bargain: the empty `scopes` is a decoy, and the
 * real delivery scopes — which are not columns on `realtime_events`, so they
 * cannot be read back — must still reach this build's fan-out intact.
 */
test('the compact ws envelope still carries its real delivery scopes', async () => {
  const organizationId = parseOrganizationId(randomUUID())
  const channelId = parseChannelId(randomUUID())
  const scopes: WsScope[] = [
    { kind: 'organization', organizationId },
    { kind: 'channel', channelId },
  ]
  const message = {
    data: { content: 'x'.repeat(20_000) },
    event: 'message.created',
    ts: new Date().toISOString(),
    type: 'event' as const,
  }
  const ws = capturingPool([
    {
      id: '512',
      organization_id: organizationId,
      channel_id: channelId,
      recipient_user_id: null,
      event_type: message.event,
      payload: message,
      created_at: new Date(),
    },
  ])
  await publishWsEvent(ws.pool, 'nessie_realtime_test', { message, scopes })

  const envelope = JSON.parse(ws.notified[0]!) as RealtimeNotificationEnvelope
  const readBack = {
    query: async () => ({
      rows: [
        {
          id: '512',
          organization_id: organizationId,
          channel_id: channelId,
          recipient_user_id: null,
          event_type: message.event,
          payload: message,
          created_at: new Date(),
        },
      ],
    }),
  } as unknown as Pool

  const resolved = await resolveRealtimeNotification(readBack, envelope)
  if (!resolved || resolved.kind !== 'ws') {
    assert.fail(`the compact ws envelope must resolve to its row, got ${JSON.stringify(resolved)}`)
  }
  assert.deepEqual(resolved.scopes, scopes)
  assert.equal(resolved.eventId, '512')
  assert.deepEqual(resolved.message, message)
})
