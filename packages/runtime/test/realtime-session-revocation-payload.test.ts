import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { Pool } from 'pg'
import { parseOrganizationId, type WsScope } from '@nessie/schemas'

import { PgRealtimeTransport } from '../src/realtime.js'

/**
 * The session-revocation payload and the previous build (horizontal-scaling
 * audit 1.8).
 *
 * `kind: 'auth'` is new on this branch, and Nessie deploys blue-green: for the
 * whole length of a swap a replica running the *previous* build holds a LISTEN
 * on the same channel and receives every payload this one publishes. That build
 * cannot recognise `'auth'`, so the only thing that keeps it alive is the shape
 * of the payload itself — no guard can be added to code that is already
 * deployed. Logging out is not a rare event, so a payload it chokes on takes
 * down every old replica the moment the first person signs out mid-deploy.
 *
 * The fan-out's own `message` and `Array.isArray` guards are the other half of
 * this, and they are not a substitute: they protect a listener running *this*
 * build, never the one running during the swap.
 *
 * These tests pin the wire bytes `PgRealtimeTransport.publishSessionRevocation`
 * actually produces, not a literal typed by hand, and then run them through the
 * previous build's reads transcribed verbatim below.
 */

const SESSION_ID = randomUUID()

/** Captures the JSON string handed to `pg_notify`, which is what a listener sees. */
const capturingPool = (captured: string[]): Pool => ({
  query: async (_text: string, values: unknown[]) => {
    captured.push(String(values[1]))
    return { rows: [] }
  },
} as unknown as Pool)

const publishedRevocationPayload = async (): Promise<Record<string, unknown>> => {
  const captured: string[] = []
  const transport = new PgRealtimeTransport(capturingPool(captured), 'postgres://unused')
  await transport.publishSessionRevocation(SESSION_ID)
  assert.equal(captured.length, 1, 'a revocation must produce exactly one NOTIFY')
  return JSON.parse(captured[0] as string) as Record<string, unknown>
}

/**
 * `api/src/realtime/notification-delivery.ts` transcribed down to the reads it
 * performs on a payload whose `kind` it does not know — deliberately *without*
 * the `message` and `Array.isArray` guards this build's listener now has, since
 * a replica old enough not to know `'auth'` may also be old enough not to have
 * them, and neither can be added to a process that is already deployed. It runs
 * these reads inside an unawaited promise, so a TypeError here is an unhandled
 * rejection, which terminates the process on Node 22.
 *
 * The reads, in the order that build performs them:
 *   1. `notification.kind === 'sse'` — false, so the SSE branch is skipped.
 *   2. `typeof notification.eventId === 'string'` — absent, so `replayEvent` is
 *      null and the user-SSE block, the only place `notification.message` is
 *      dereferenced, never runs.
 *   3. for every WebSocket connection: `shouldDeliverWsNotification`, whose
 *      first statement is `input.notificationScopes.filter(...)`.
 * Step 3 is the one that matters: the loop is outside the `replayEvent` block
 * and runs for every socket that build is holding, and the admin always holds
 * one.
 */
const deliverOnThePreviousBuild = (
  payload: Record<string, unknown>,
  wsConnections: { scopes: WsScope[]; sent: unknown[] }[],
): void => {
  const notification = payload as {
    eventId?: string
    kind: string
    message?: unknown
    scopes: WsScope[]
  }
  if (notification.kind === 'sse') return

  const replayEvent = typeof notification.eventId === 'string' ? notification.eventId : null
  if (replayEvent !== null) {
    throw new Error('an auth payload must carry no eventId, or the old build reads `message`')
  }

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

    connection.sent.push(notification.message)
  }
}

test('the published revocation payload carries an empty scopes array', async () => {
  const payload = await publishedRevocationPayload()

  assert.equal(payload.kind, 'auth')
  assert.equal(payload.sessionId, SESSION_ID)
  // The previous build reads `scopes` unchecked, so it has to be an array...
  assert.ok(
    Array.isArray(payload.scopes),
    'the previous build calls `.filter` on `scopes` without checking it',
  )
  // ...and empty, so that read matches no connection and delivers nothing.
  assert.deepEqual(payload.scopes, [])
  // No eventId: that is what stops the old build ever reaching `message`.
  assert.equal(payload.eventId, undefined)
})

test('the published revocation payload is inert on the previous build', async () => {
  const payload = await publishedRevocationPayload()

  // Every connection shape that build's loop can be holding, including the
  // admin's, which subscribes to an organization scope.
  const wsConnections = [
    { scopes: [] as WsScope[], sent: [] as unknown[] },
    {
      scopes: [
        { kind: 'organization', organizationId: parseOrganizationId(randomUUID()) },
      ] as WsScope[],
      sent: [] as unknown[],
    },
  ]

  // Against the payload as it was before this fix — `{ kind: 'auth', sessionId }`
  // with no `scopes` — this throws `TypeError: Cannot read properties of
  // undefined (reading 'filter')`, which is the unhandled rejection that kills
  // the old replica.
  assert.doesNotThrow(() => {
    deliverOnThePreviousBuild(payload, wsConnections)
  })

  for (const connection of wsConnections) {
    assert.deepEqual(
      connection.sent,
      [],
      'a replica-to-replica control payload must reach no client, on either build',
    )
  }
})
