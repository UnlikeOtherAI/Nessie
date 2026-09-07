// Every byte this branch can put on `nessie_realtime`, run through the reads a
// replica on the previous build performs without checking them.
//
// Nessie deploys blue-green, so for the length of a swap a replica running the
// *previous* image holds a LISTEN on the same channel and receives everything a
// new one publishes. That build parses any valid JSON and hands the result to a
// fan-out that runs in an **unawaited** promise: a TypeError there is an
// unhandled rejection, and Node 22 ends the process. No guard can be added to
// it — it is already deployed — so the payload's own shape is the whole defence.
// This has been caught twice pre-merge, both times on a shape that had been
// reasoned about rather than executed.
//
// So this test does not type a payload by hand. It captures what the publish
// paths actually emit, over a real LISTEN, and runs those bytes through the
// previous build's reads transcribed below — including the oversized ones,
// which are the only shapes row 5.4 changes anything about.

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
  type WsScope,
} from '@nessie/schemas'

import { PgRealtimeTransport } from '../src/realtime.js'

const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

const OVERSIZED_REPLY = 'x'.repeat(12_000)

// `publishWs` parses through `WsEventSchema`, so the ws lane's oversized case
// has to be a real event whose payload can actually grow — the message preview.
const messageNew = (threadId: string, contentPreview: string) => ({
  contentPreview,
  messageId: randomUUID(),
  role: 'assistant' as const,
  threadId: parseThreadId(threadId),
})

/**
 * `api/src/realtime/notification-delivery.ts` transcribed down to the reads it
 * performs on a payload whose `kind` it does not know, and deliberately
 * *without* the `message` and `Array.isArray` guards the current build's
 * listener has: a replica old enough to be the one being replaced may be old
 * enough to lack them, and neither can be added to a process already running.
 *
 * The reads, in the order that build performs them:
 *   1. `notification.kind === 'sse'` — its own branch, which only ever touches
 *      thread connections and returns.
 *   2. `typeof notification.eventId === 'string'` — if so it builds a replay
 *      event, which dereferences `notification.message` immediately.
 *   3. for every WebSocket connection: `notification.scopes.filter(...)`.
 * Step 3 is the one that matters: it runs for every socket that build is
 * holding, and the admin always holds one.
 */
const deliverOnThePreviousBuild = (
  payload: Record<string, unknown>,
  wsConnections: { scopes: WsScope[]; sent: unknown[] }[],
): void => {
  const notification = payload as {
    eventId?: string
    kind: string
    message?: { event: string; ts: string }
    scopes: WsScope[]
    threadId?: string
  }
  if (notification.kind === 'sse') {
    // The thread branch. It reads `threadId` and `sequence` and returns without
    // ever reaching the WebSocket loop.
    return
  }

  const replayEvent =
    typeof notification.eventId === 'string'
      ? {
          createdAt: new Date(notification.message!.ts),
          eventType: notification.message!.event,
          id: notification.eventId,
        }
      : null

  for (const connection of wsConnections) {
    // Verbatim from the deployed `shouldDeliverWsNotification`: an unchecked
    // `.filter` on the notification's scopes, then a key-set intersection with
    // the connection's own. Nothing here tolerates a missing array.
    const channelScopes = notification.scopes.filter((scope) => scope.kind === 'channel')
    const userScopes = notification.scopes.filter((scope) => scope.kind === 'user')
    const dashboardScopes = notification.scopes.filter((scope) => scope.kind === 'dashboard')
    const scopeKeys = new Set(notification.scopes.map((scope) => JSON.stringify(scope)))
    const shouldDeliver =
      userScopes.length > 0 || channelScopes.length > 0 || dashboardScopes.length > 0
        ? true
        : connection.scopes.some((scope) => scopeKeys.has(JSON.stringify(scope)))
    if (!shouldDeliver) continue

    connection.sent.push(replayEvent ?? notification.message)
  }
}

const startListener = async (
  connectionString: string,
  channel: string,
): Promise<{ received: Record<string, unknown>[]; stop: () => Promise<void> }> => {
  const client = new Client({ connectionString })
  const received: Record<string, unknown>[] = []
  client.on('notification', (notification) => {
    if (!notification.payload) return
    received.push(JSON.parse(notification.payload) as Record<string, unknown>)
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

const seedTenant = async (pool: Pool): Promise<{ organizationId: string; threadId: string }> => {
  const organizationId = randomUUID()
  const projectId = randomUUID()
  const teamId = randomUUID()
  const channelId = randomUUID()
  const threadId = randomUUID()

  await pool.query(
    `INSERT INTO organizations (id, name, created_at, updated_at)
     VALUES ($1, 'Realtime wire inertness', now(), now())`,
    [organizationId],
  )
  await pool.query(
    `INSERT INTO projects (id, name, organization_id, created_at, updated_at)
     VALUES ($1, 'Realtime wire inertness', $2, now(), now())`,
    [projectId, organizationId],
  )
  await pool.query(
    `INSERT INTO teams (id, name, project_id, created_at, updated_at)
     VALUES ($1, 'Realtime wire inertness', $2, now(), now())`,
    [teamId, projectId],
  )
  await pool.query(
    `INSERT INTO channels (
       id, label, slug, organization_id, project_id, team_id, created_at, updated_at
     )
     VALUES ($1, 'Realtime wire inertness', $2, $3, $4, $5, now(), now())`,
    [channelId, `realtime-inert-${channelId}`, organizationId, projectId, teamId],
  )
  await pool.query(
    `INSERT INTO threads (id, channel_id, created_at, updated_at) VALUES ($1, $2, now(), now())`,
    [threadId, channelId],
  )
  return { organizationId, threadId }
}

runIfDatabase('nothing this branch publishes can kill a replica on the previous build', async () => {
  const connectionString = process.env.DATABASE_URL!
  const channel = `nessie_realtime_test_${randomUUID().replaceAll('-', '')}`
  const pool = new Pool({ connectionString, max: 5 })
  const listener = await startListener(connectionString, channel)
  const seed = await seedTenant(pool)

  try {
    const transport = new PgRealtimeTransport(pool, connectionString, channel)
    const scopes: WsScope[] = [
      { kind: 'organization', organizationId: parseOrganizationId(seed.organizationId) },
      {
        kind: 'user',
        organizationId: parseOrganizationId(seed.organizationId),
        userId: parseUserId(randomUUID()),
      },
    ]

    // Every door to `pg_notify` this branch has, oversized where oversizing is
    // what changes the shape.
    await transport.publishSse(seed.threadId, 'stream.done', {
      agentId: parseAgentId(randomUUID()),
      content: OVERSIZED_REPLY,
      messageId: randomUUID(),
      runId: parseRunId(randomUUID()),
    })
    await transport.publishSse(seed.threadId, 'stream.done', {
      agentId: parseAgentId(randomUUID()),
      content: 'short',
      messageId: randomUUID(),
      runId: parseRunId(randomUUID()),
    })
    await transport.publishWs(scopes, { data: messageNew(seed.threadId, OVERSIZED_REPLY), event: 'message.new' })
    await transport.publishWs(scopes, { data: messageNew(seed.threadId, 'short'), event: 'message.new' })
    await transport.publishSseEphemeral(seed.threadId, 'stream.document.delta', {
      content: 'live fragment',
      offset: 0,
      runId: parseRunId(randomUUID()),
      seq: 1,
      sessionId: randomUUID(),
    })
    await transport.publishSessionRevocation(randomUUID())

    const deadline = Date.now() + 15_000
    while (listener.received.length < 6 && Date.now() < deadline) {
      await delay(25)
    }
    assert.equal(listener.received.length, 6, 'every publish must have reached the wire')

    // Two compact forms among them, or this test is asserting nothing about the
    // shapes row 5.4 introduces on the wire.
    const kinds = listener.received.map((payload) => payload.kind)
    assert.ok(kinds.includes('sse-ref'), `expected an sse-ref among ${JSON.stringify(kinds)}`)
    assert.ok(kinds.includes('ws-ref'), `expected a ws-ref among ${JSON.stringify(kinds)}`)

    for (const payload of listener.received) {
      const label = String(payload.kind)
      // `scopes` is the one field the old fan-out dereferences on the path an
      // unknown kind takes — missing it is the crash. A plain `sse` payload is
      // exempt and carries none, because that build recognises `'sse'` and its
      // branch returns before the WebSocket loop; every other kind must have
      // one, and it must be empty or this build is delivering through a listener
      // that cannot read the event.
      if (label !== 'sse') {
        assert.ok(
          Array.isArray(payload.scopes),
          `${label}: the previous build calls .filter on scopes without checking it`,
        )
      }
      if (label.endsWith('-ref') || label === 'auth') {
        assert.deepEqual(payload.scopes, [], `${label}: that array must be empty`)
        assert.equal(
          payload.eventId,
          undefined,
          `${label}: a top-level eventId makes the old build dereference message and die a line earlier`,
        )
        assert.equal(payload.message, undefined, `${label}: and there is no message to dereference`)
      }

      const wsConnections = [
        { scopes: [] as WsScope[], sent: [] as unknown[] },
        { scopes, sent: [] as unknown[] },
      ]
      assert.doesNotThrow(() => {
        deliverOnThePreviousBuild(payload, wsConnections)
      }, `${label}: killed a replica on the previous build`)

      if (label.endsWith('-ref')) {
        for (const connection of wsConnections) {
          assert.deepEqual(
            connection.sent,
            [],
            `${label}: a payload the old build cannot read must reach nobody there`,
          )
        }
      }
    }
  } finally {
    await listener.stop()
    await pool.query('DELETE FROM organizations WHERE id = $1', [seed.organizationId])
    await pool.end()
  }
})
