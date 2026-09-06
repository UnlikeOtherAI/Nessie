import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import cookie from '@fastify/cookie'
import type { PrismaClient } from '@prisma/client'
import Fastify from 'fastify'
import type { RealtimeNotificationPayload } from '@nessie/runtime'

import { issueSessionToken } from '../src/auth/session.js'
import { createWsNotificationDelivery } from '../src/realtime/notification-delivery.js'
import { registerAuthLogoutRoute } from '../src/routes/auth-logout.js'
import { createAuthSessionRevocationChecker } from '../src/services/auth-session-registry.js'

/**
 * Logout and the session-revocation cache (horizontal-scaling audit 1.8).
 *
 * Every API replica memoises the `auth_sessions` lookup for 30 s.
 * `DELETE /api/auth/sessions/:sessionId` has always dropped the revoked sid
 * from the handling replica's cache; `DELETE /api/auth/session` (logout) did
 * not, and leaned on the live refresh-row check that happens to run per
 * request. These tests pin both halves of the fix against the real checker,
 * so they measure the cached verdict rather than a callback having fired:
 * without the local invalidate the first assertion reads `false` from a warm
 * cache entry, and without the broadcast the second replica does the same.
 */

const AUTH_SECRET = 'revocation-cache-test-secret'
const USER_ID = randomUUID()
const SESSION_ID = randomUUID()

const bearerFor = (sessionId: string): string => issueSessionToken({
  org: randomUUID(),
  proj: randomUUID(),
  providerId: 'uoa',
  providerType: 'uoa',
  roles: ['owner'],
  sub: USER_ID,
  team: randomUUID(),
  tv: 1,
}, AUTH_SECRET, 3600, sessionId).token

/**
 * The shared `auth_sessions` table both replicas read. `revokedAt` starts null
 * so each replica can warm its cache with an "alive" verdict first — which is
 * exactly the state the bug leaves in place for the rest of the TTL.
 */
const makeRegistryPrisma = (revoked: { at: Date | null }) => ({
  authSession: {
    findUnique: async (): Promise<{ revokedAt: Date | null }> => ({ revokedAt: revoked.at }),
  },
} as unknown as PrismaClient)

test('logout drops the revoked sid from the handling replica and every listening one', async () => {
  const shared = { at: null as Date | null }
  const replicaA = createAuthSessionRevocationChecker(makeRegistryPrisma(shared))
  const replicaB = createAuthSessionRevocationChecker(makeRegistryPrisma(shared))

  // Replica B is a second process: its only link to the revocation is the
  // NOTIFY payload its realtime listener receives.
  const { deliverNotification } = createWsNotificationDelivery({
    onSessionRevoked: replicaB.invalidate,
  })
  const broadcast: RealtimeNotificationPayload[] = []

  const app = Fastify({ logger: false })
  await app.register(cookie)
  registerAuthLogoutRoute(app, {
    authSecret: AUTH_SECRET,
    getAuthorizationToken: (request) => {
      const header = request.headers.authorization
      return typeof header === 'string' ? header.replace(/^Bearer /, '') : null
    },
    invalidateSessionRevocationCache: replicaA.invalidate,
    prisma: {} as PrismaClient,
    publishSessionRevocation: async (sessionId) => {
      const payload: RealtimeNotificationPayload = { kind: 'auth', sessionId }
      broadcast.push(payload)
      await deliverNotification(payload)
    },
  }, {
    clearPresence: async () => undefined,
    revokeByRefreshToken: async () => null,
    revokeSession: async (_prisma, _userId, sessionId) => {
      // The durable write logout performs, mirrored onto the shared row.
      shared.at = sessionId === SESSION_ID ? new Date() : null
      return 1
    },
  } as never)
  await app.ready()

  // Both replicas served a request on this session moments before the logout,
  // so both hold a warm "not revoked" entry.
  assert.equal(await replicaA(SESSION_ID), false)
  assert.equal(await replicaB(SESSION_ID), false)

  const response = await app.inject({
    method: 'DELETE',
    url: '/api/auth/session',
    headers: { authorization: `Bearer ${bearerFor(SESSION_ID)}` },
  })
  assert.equal(response.statusCode, 204)

  // The replica that handled the logout must not honour the token for the
  // remainder of its TTL...
  assert.equal(await replicaA(SESSION_ID), true)
  // ...and neither must any other, which learns of it from the NOTIFY.
  assert.deepEqual(broadcast, [{ kind: 'auth', sessionId: SESSION_ID }])
  assert.equal(await replicaB(SESSION_ID), true)

  await app.close()
})

test('an auth control notification reaches no client connection', async () => {
  const dropped: string[] = []
  const { deliverNotification, userSseConnections, wsConnections } =
    createWsNotificationDelivery({
      onSessionRevoked: (sessionId) => {
        dropped.push(sessionId)
      },
    })

  await deliverNotification({ kind: 'auth', sessionId: SESSION_ID })

  assert.deepEqual(dropped, [SESSION_ID])
  // A revocation is replica-to-replica bookkeeping: it must never be fanned
  // out as an event, which would tell every subscriber somebody signed out.
  assert.equal(userSseConnections.size, 0)
  assert.equal(wsConnections.size, 0)
})

test('a broadcast failure never fails the logout', async () => {
  const shared = { at: null as Date | null }
  const replica = createAuthSessionRevocationChecker(makeRegistryPrisma(shared))

  const app = Fastify({ logger: false })
  await app.register(cookie)
  registerAuthLogoutRoute(app, {
    authSecret: AUTH_SECRET,
    getAuthorizationToken: (request) => {
      const header = request.headers.authorization
      return typeof header === 'string' ? header.replace(/^Bearer /, '') : null
    },
    invalidateSessionRevocationCache: replica.invalidate,
    prisma: {} as PrismaClient,
    publishSessionRevocation: async () => {
      throw new Error('LISTEN connection is down')
    },
  }, {
    clearPresence: async () => undefined,
    revokeByRefreshToken: async () => null,
    revokeSession: async () => {
      shared.at = new Date()
      return 1
    },
  } as never)
  await app.ready()

  const response = await app.inject({
    method: 'DELETE',
    url: '/api/auth/session',
    headers: { authorization: `Bearer ${bearerFor(SESSION_ID)}` },
  })

  // The session is durably revoked either way; the notification only removes
  // the other replicas' TTL wait, so losing it is latency, not correctness.
  assert.equal(response.statusCode, 204)
  assert.equal(await replica(SESSION_ID), true)

  await app.close()
})
