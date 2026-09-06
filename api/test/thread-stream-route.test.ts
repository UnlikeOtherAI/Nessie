import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerThreadRoutes } from '../src/routes/threads.js'
import {
  createWsNotificationDelivery,
  type ThreadSseConnection,
} from '../src/realtime/notification-delivery.js'
import { REALTIME_ENTITLEMENT_TTL_MS } from '../src/realtime/delivery-entitlements.js'

/**
 * `GET /api/threads/:threadId/stream` is the route wiring for F4-3
 * (`docs/reviews/2026-09-05-api-architecture-review.md`): the hub's per-event
 * entitlement recheck (`threadConnectionStillEntitled` in
 * `notification-delivery.ts`) only works when the connection carries its
 * viewer, and only the route knows who is watching. This exercises the real
 * route handler end to end — not just the hub in isolation, which is what
 * `realtime-delivery-revocation.test.ts` already covers — so a regression
 * that goes back to registering by thread id alone (as the route used to)
 * fails here even if the hub's own logic stays correct.
 */

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001'
const USER_ID = '00000000-0000-4000-8000-000000000002'
const CHANNEL_ID = '00000000-0000-4000-8000-000000000003'
const THREAD_ID = '00000000-0000-4000-8000-000000000004'

const actorContext: AuthorizedActionContext = {
  actionContext: { requestId: 'request-1' },
  actor: { actorId: USER_ID, actorType: 'user', roles: ['member'] },
  tenant: { organizationId: ORGANIZATION_ID },
} as unknown as AuthorizedActionContext

const threadEvent = (sequence: number) => ({
  data: { text: 'chunk' },
  event: 'stream.delta' as const,
  kind: 'sse' as const,
  sequence,
  threadId: THREAD_ID,
})

test('a channel member revoked mid-stream stops receiving GET /api/threads/:id/stream events on the very next one', async () => {
  const prisma = {
    thread: {
      findFirst: async () => ({
        id: THREAD_ID,
        channel: {
          id: CHANNEL_ID,
          organizationId: ORGANIZATION_ID,
          systemChannelType: null,
          type: 'standard',
        },
      }),
    },
  } as unknown as PrismaClient

  let channelAccess = true
  let capturedAddSseInput: unknown = null
  const written: string[] = []

  // A controllable clock: the entitlement gate memoizes each answer for
  // `REALTIME_ENTITLEMENT_TTL_MS` so a token-by-token burst costs one query,
  // which means a revocation only takes effect once that window has passed —
  // exactly like `realtime-delivery-revocation.test.ts` at the hub level.
  let clockValue = 1_000
  const advancePastTtl = () => {
    clockValue += REALTIME_ENTITLEMENT_TTL_MS + 1
  }

  // The real entitlement gate (notification-delivery.ts), not a stub of it —
  // this is what proves the route hands it a viewer it can re-check against,
  // rather than a bare thread id.
  const { deliverNotification, threadSseConnections } = createWsNotificationDelivery({
    canAccessChannelEvent: async ({ channelId, organizationId, userId }) => {
      assert.equal(channelId, CHANNEL_ID)
      assert.equal(organizationId, ORGANIZATION_ID)
      assert.equal(userId, USER_ID)
      return channelAccess
    },
    entitlements: {
      resolveThreadChannelId: async (threadId) => {
        assert.equal(threadId, THREAD_ID)
        return CHANNEL_ID
      },
    },
    now: () => clockValue,
  })

  const app = Fastify({ logger: false })
  let requestRaw: NodeJS.EventEmitter | null = null
  app.addHook('onRequest', async (request, reply) => {
    requestRaw = request.raw
    // `reply.raw.socket?.setNoDelay(true)` is a real socket call in
    // production; light-my-request's injected response carries a null-socket
    // stand-in that does not implement it, which would otherwise throw
    // inside the route's async handler and silently strand the injected
    // request (Fastify has already hijacked the reply by that point, so
    // nothing surfaces the rejection). Patch it in for the harness only.
    const socket = reply.raw.socket as { setNoDelay?: (flag: boolean) => void } | undefined
    if (socket && typeof socket.setNoDelay !== 'function') {
      socket.setNoDelay = () => undefined
    }
  })

  registerThreadRoutes(app, {
    allowedCorsOrigins: [],
    buildChannelRealtimeScopes: () => [],
    config: { mode: 'selfHosted' },
    prisma,
    realtimeHub: {
      addSseConnection: async (
        input: string | { kind: 'thread'; organizationId: string; threadId: string; userId: string },
        response: { once: (event: 'drain', listener: () => void) => unknown; write: (chunk: string) => boolean },
      ) => {
        capturedAddSseInput = input
        const connection: ThreadSseConnection = {
          kind: 'thread',
          channelId: null,
          hydrating: false,
          lastSequence: 0,
          pending: [],
          response: {
            once: (event, listener) => response.once(event, listener),
            write: (chunk) => {
              written.push(chunk)
              return response.write(chunk)
            },
          },
          saturated: false,
          threadId: typeof input === 'string' ? input : input.threadId,
          viewer:
            typeof input === 'string'
              ? null
              : { organizationId: input.organizationId, userId: input.userId },
        }
        threadSseConnections.add(connection)
        return connection
      },
      publishWs: async () => undefined,
      removeSseConnection: (connection: ThreadSseConnection) => {
        threadSseConnections.delete(connection)
      },
    },
    requireActorContext: () => actorContext,
  } as unknown as Parameters<typeof registerThreadRoutes>[1])

  const injected = app.inject({ method: 'GET', url: `/api/threads/${THREAD_ID}/stream` })
  // Let the handler run past its `await addSseConnection(...)`.
  await new Promise((resolve) => setTimeout(resolve, 20))

  try {
    // The regression this guards: registering by thread id alone (a bare
    // string) leaves `viewer: null`, and `threadConnectionStillEntitled`
    // treats a null viewer as "no recheck possible" — inert by construction.
    assert.deepEqual(capturedAddSseInput, {
      kind: 'thread',
      organizationId: ORGANIZATION_ID,
      threadId: THREAD_ID,
      userId: USER_ID,
    })

    await deliverNotification(threadEvent(1))
    assert.equal(written.length, 1, 'a member watching the real route receives the stream')

    // Removed from the channel behind the thread mid-connection.
    channelAccess = false
    advancePastTtl()

    await deliverNotification(threadEvent(2))
    assert.equal(
      written.length,
      1,
      'delivery on the route-registered connection stops on the very next event',
    )
  } finally {
    // Emit `close` on the request directly rather than `.destroy()` it: the
    // harness's own built-in `close` listener (registered before the route
    // runs) calls `res.destroy()` whenever `req.destroyed` is set, racing
    // the route's own cleanup and destroying the response before its
    // `reply.raw.end()` can finish it cleanly. Emitting the event without
    // destroying the request leaves that built-in listener a no-op and lets
    // the route's own `request.raw.on('close', ...)` handler — which clears
    // the keepalive interval and ends the response — run uncontested.
    requestRaw?.emit('close')
    await injected
    await app.close()
  }
})
