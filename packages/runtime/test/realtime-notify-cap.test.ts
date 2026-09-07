// The `pg_notify` cap and the payloads that do not fit under it
// (horizontal-scaling audit 2.7, overview row 5.4).
//
// Postgres refuses a NOTIFY payload of 8000 bytes or more, and `stream.done`
// carries the whole assistant reply, which has no bound. Inside the publish
// transaction that refusal takes the INSERT with it: the run's completion stage
// raises, and either the event is lost or — before the publish became one
// transaction — the row was committed and the announcement simply threw into
// the caller. Either way the client sees the reply only on its next reconnect.
//
// The answer is the compact `*-ref` envelope: an oversized payload is announced
// by its row id and the listener reads the row back, so nothing above the
// transport ever meets the compact form. These tests drive that through a real
// Postgres, because the failure being prevented is Postgres' own.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { Client, Pool } from 'pg'
import {
  parseAgentId,
  parseOrganizationId,
  parseRunId,
  parseThreadId,
  parseUserId,
} from '@nessie/schemas'

import {
  NOTIFY_PAYLOAD_LIMIT_BYTES,
  PgRealtimeTransport,
  resolveRealtimeNotification,
  type RealtimeNotificationEnvelope,
  type RealtimeNotificationPayload,
} from '../src/realtime.js'

const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

const NOTIFICATION_TIMEOUT_MS = 15_000

// Comfortably past Postgres' 8000-byte refusal even before JSON escaping and
// the envelope around it, and no larger than an ordinary long answer.
const OVERSIZED_REPLY = 'x'.repeat(12_000)

type Seed = { channelId: string; organizationId: string; threadId: string }

// `publishWs` parses through `WsEventSchema`, so the ws lane's oversized case
// has to be a real event whose payload can actually grow — the message preview.
const messageNew = (threadId: string, contentPreview: string) => ({
  contentPreview,
  messageId: randomUUID(),
  role: 'assistant' as const,
  threadId: parseThreadId(threadId),
})

const startListener = async (
  connectionString: string,
  channel: string,
): Promise<{ received: RealtimeNotificationEnvelope[]; stop: () => Promise<void> }> => {
  const client = new Client({ connectionString })
  const received: RealtimeNotificationEnvelope[] = []
  client.on('notification', (notification) => {
    if (!notification.payload) return
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

const waitFor = async (received: unknown[], count: number): Promise<void> => {
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
  }
  const projectId = randomUUID()
  const teamId = randomUUID()

  await pool.query(
    `INSERT INTO organizations (id, name, created_at, updated_at)
     VALUES ($1, 'Realtime notify cap', now(), now())`,
    [seed.organizationId],
  )
  await pool.query(
    `INSERT INTO projects (id, name, organization_id, created_at, updated_at)
     VALUES ($1, 'Realtime notify cap', $2, now(), now())`,
    [projectId, seed.organizationId],
  )
  await pool.query(
    `INSERT INTO teams (id, name, project_id, created_at, updated_at)
     VALUES ($1, 'Realtime notify cap', $2, now(), now())`,
    [teamId, projectId],
  )
  await pool.query(
    `INSERT INTO channels (
       id, label, slug, organization_id, project_id, team_id, created_at, updated_at
     )
     VALUES ($1, 'Realtime notify cap', $2, $3, $4, $5, now(), now())`,
    [seed.channelId, `realtime-cap-${seed.channelId}`, seed.organizationId, projectId, teamId],
  )
  await pool.query(
    `INSERT INTO threads (id, channel_id, created_at, updated_at)
     VALUES ($1, $2, now(), now())`,
    [seed.threadId, seed.channelId],
  )
  return seed
}

const dropTenant = (pool: Pool, organizationId: string): Promise<unknown> =>
  pool.query('DELETE FROM organizations WHERE id = $1', [organizationId])

runIfDatabase(
  'an oversized stream.done publishes, travels as a row id, and resolves back whole',
  async () => {
    const connectionString = process.env.DATABASE_URL!
    const channel = `nessie_realtime_test_${randomUUID().replaceAll('-', '')}`
    const pool = new Pool({ connectionString, max: 5 })
    const listener = await startListener(connectionString, channel)
    const seed = await seedTenant(pool)

    try {
      const transport = new PgRealtimeTransport(pool, connectionString, channel)
      const messageId = randomUUID()

      // Without the compact form this raises `payload string too long` inside
      // the publish transaction and takes the row with it.
      const published = await transport.publishSse(seed.threadId, 'stream.done', {
        agentId: parseAgentId(randomUUID()),
        content: OVERSIZED_REPLY,
        messageId,
        runId: parseRunId(randomUUID()),
      })

      const row = await pool.query('SELECT 1 FROM thread_stream_events WHERE id = $1', [
        published.sequence,
      ])
      assert.equal(row.rowCount, 1, 'the durable row must be committed')

      await waitFor(listener.received, 1)
      assert.equal(listener.received.length, 1, 'the publish must announce itself exactly once')

      const envelope = listener.received[0]!
      assert.equal(envelope.kind, 'sse-ref', 'an oversized payload travels as its row id')
      assert.ok(
        Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= NOTIFY_PAYLOAD_LIMIT_BYTES,
        'and the compact form is what makes it fit',
      )

      // Nothing above the transport ever meets the compact form: the listener
      // reads the row back and hands on a plain payload with the whole reply.
      const resolved = await resolveRealtimeNotification(pool, envelope)
      assert.ok(resolved, 'the row must be readable back')
      assert.equal(resolved.kind, 'sse')
      const data = (resolved as Extract<RealtimeNotificationPayload, { kind: 'sse' }>).data as {
        content: string
      }
      assert.equal(data.content, OVERSIZED_REPLY, 'and the content must survive the round trip')
    } finally {
      await listener.stop()
      await dropTenant(pool, seed.organizationId)
      await pool.end()
    }
  },
)

runIfDatabase('an oversized ws publish travels as a row id too', async () => {
  const connectionString = process.env.DATABASE_URL!
  const channel = `nessie_realtime_test_${randomUUID().replaceAll('-', '')}`
  const pool = new Pool({ connectionString, max: 5 })
  const listener = await startListener(connectionString, channel)
  const seed = await seedTenant(pool)

  try {
    const transport = new PgRealtimeTransport(pool, connectionString, channel)
    await transport.publishWs(
      [
        { kind: 'organization', organizationId: parseOrganizationId(seed.organizationId) },
        {
          kind: 'user',
          organizationId: parseOrganizationId(seed.organizationId),
          userId: parseUserId(randomUUID()),
        },
      ],
      { data: messageNew(seed.threadId, OVERSIZED_REPLY), event: 'message.new' },
    )

    await waitFor(listener.received, 1)
    const envelope = listener.received[0]!
    assert.equal(envelope.kind, 'ws-ref')
    const resolved = await resolveRealtimeNotification(pool, envelope)
    assert.ok(resolved, 'the realtime_events row must be readable back')
    assert.equal(resolved.kind, 'ws')
  } finally {
    await listener.stop()
    await dropTenant(pool, seed.organizationId)
    await pool.end()
  }
})

runIfDatabase('an oversized rowless publish is dropped, never raised into its caller', async () => {
  // `publishSseEphemeral` writes no row, so there is nothing to announce by id.
  // The lane is built for a dropped frame — it drops them under backpressure
  // too, and the client rebuilds from the document-stream bootstrap — and it is
  // not built for a raise, which would fail the run that was streaming.
  const connectionString = process.env.DATABASE_URL!
  const channel = `nessie_realtime_test_${randomUUID().replaceAll('-', '')}`
  const pool = new Pool({ connectionString, max: 5 })
  const seed = await seedTenant(pool)

  try {
    const transport = new PgRealtimeTransport(pool, connectionString, channel)
    await transport.publishSseEphemeral(seed.threadId, 'stream.document.delta', {
      content: OVERSIZED_REPLY,
      offset: 0,
      runId: parseRunId(randomUUID()),
      seq: 1,
      sessionId: randomUUID(),
    })
  } finally {
    await dropTenant(pool, seed.organizationId)
    await pool.end()
  }
})

runIfDatabase('a re-read notification cannot be overtaken by a smaller one behind it', async () => {
  // The compact form costs a round trip the full form does not pay. Without the
  // transport's resolution chain, an oversized event could reach the fan-out
  // *after* a smaller one published later, and a per-connection watermark only
  // moves forward — so the oversized one would be skipped for good, and replay
  // (`id > watermark`) could not return it either.
  const connectionString = process.env.DATABASE_URL!
  const channel = `nessie_realtime_test_${randomUUID().replaceAll('-', '')}`
  const pool = new Pool({ connectionString, max: 5 })
  const seed = await seedTenant(pool)
  const transport = new PgRealtimeTransport(pool, connectionString, channel)
  const delivered: number[] = []

  try {
    await transport.listen((payload) => {
      if (payload.kind === 'sse') {
        delivered.push(payload.sequence)
      }
    })

    const runId = parseRunId(randomUUID())
    const oversized = await transport.publishSse(seed.threadId, 'stream.done', {
      agentId: parseAgentId(randomUUID()),
      content: OVERSIZED_REPLY,
      messageId: randomUUID(),
      runId,
    })
    const small = await transport.publishSse(seed.threadId, 'stream.done', {
      agentId: parseAgentId(randomUUID()),
      content: 'short',
      messageId: randomUUID(),
      runId,
    })

    await waitFor(delivered, 2)
    assert.deepEqual(
      delivered,
      [oversized.sequence, small.sequence],
      'the id-order publish must reach the fan-out in id order, whatever form it travelled in',
    )
  } finally {
    await transport.close()
    await dropTenant(pool, seed.organizationId)
    await pool.end()
  }
})
