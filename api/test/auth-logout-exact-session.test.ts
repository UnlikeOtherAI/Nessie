import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import cookie from '@fastify/cookie'
import type { PrismaClient } from '@prisma/client'
import Fastify from 'fastify'

import { issueSessionToken } from '../src/auth/session.js'
import { registerAuthLogoutRoute } from '../src/routes/auth-logout.js'
import {
  hasActiveUserSession,
  revokeUserSession,
} from '../src/services/refresh-session-management.js'

const AUTH_SECRET = 'logout-test-secret'
const USER_ID = randomUUID()
const SESSION_A = randomUUID()
const SESSION_B = randomUUID()

const bearerFor = (sessionId: string, ttlSeconds = 3600): string => issueSessionToken({
  org: randomUUID(),
  proj: randomUUID(),
  providerId: 'uoa',
  providerType: 'uoa',
  roles: ['owner'],
  sub: USER_ID,
  team: randomUUID(),
  tv: 1,
}, AUTH_SECRET, ttlSeconds, sessionId).token

const buildLogoutApp = async (operations: {
  clearPresence: (prisma: unknown, userId: string) => Promise<void>
  revokeByRefreshToken: (prisma: unknown, raw: string) => Promise<{ userId: string } | null>
  revokeSession: (prisma: unknown, userId: string, sessionId: string) => Promise<number>
}) => {
  const app = Fastify({ logger: false })
  await app.register(cookie)
  registerAuthLogoutRoute(app, {
    authSecret: AUTH_SECRET,
    getAuthorizationToken: (request) => {
      const header = request.headers.authorization
      return typeof header === 'string' ? header.replace(/^Bearer /, '') : null
    },
    prisma: {} as PrismaClient,
  }, operations as never)
  await app.ready()
  return app
}

test('logout accepts expired signed A and revokes only A', async () => {
  const revoked: Array<{ sessionId: string; userId: string }> = []
  const cleared: string[] = []
  let refreshRevocations = 0
  const app = await buildLogoutApp({
    revokeSession: async (_prisma, userId, sessionId) => {
      revoked.push({ sessionId, userId })
      return 1
    },
    clearPresence: async (_prisma, userId) => {
      cleared.push(userId)
    },
    revokeByRefreshToken: async () => {
      refreshRevocations += 1
      return null
    },
  })

  const response = await app.inject({
    method: 'DELETE',
    url: '/api/auth/session',
    headers: {
      authorization: `Bearer ${bearerFor(SESSION_A, -1)}`,
      cookie: `nessie_refresh=${SESSION_B}`,
    },
  })

  assert.equal(response.statusCode, 204)
  assert.deepEqual(revoked, [{ sessionId: SESSION_A, userId: USER_ID }])
  assert.deepEqual(cleared, [USER_ID])
  // The bearer identified the session, so the ambient cookie is not consulted.
  assert.equal(refreshRevocations, 0)
  // And no cookie-clear header: a delayed logout from an older app instance
  // must never erase a newer login's same-name cookie.
  assert.equal(response.headers['set-cookie'], undefined)
  await app.close()
})

test('with no usable bearer, logout revokes the family the presented cookie names', async () => {
  // The failing case FO3-4 named: an SPA that has already discarded its
  // 30-minute access token still holds a 30-day refresh cookie. Logout used to
  // answer 204 having done nothing at all, so the next POST /api/auth/refresh
  // minted a fresh session.
  for (const authorization of [undefined, 'Bearer invalid']) {
    const revokedRawTokens: string[] = []
    const cleared: string[] = []
    let sessionRevocations = 0
    const app = await buildLogoutApp({
      revokeSession: async () => {
        sessionRevocations += 1
        return 0
      },
      clearPresence: async (_prisma, userId) => {
        cleared.push(userId)
      },
      revokeByRefreshToken: async (_prisma, raw) => {
        revokedRawTokens.push(raw)
        return { userId: USER_ID }
      },
    })

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/auth/session',
      headers: {
        ...(authorization ? { authorization } : {}),
        cookie: `nessie_refresh=${SESSION_B}`,
      },
    })

    assert.equal(response.statusCode, 204)
    assert.deepEqual(revokedRawTokens, [SESSION_B])
    assert.deepEqual(cleared, [USER_ID])
    assert.equal(sessionRevocations, 0)
    assert.equal(response.headers['set-cookie'], undefined)
    await app.close()
  }
})

test('logout with neither bearer nor cookie is still an inert 204', async () => {
  let revocations = 0
  const app = await buildLogoutApp({
    revokeSession: async () => {
      revocations += 1
      return 0
    },
    clearPresence: async () => undefined,
    revokeByRefreshToken: async () => {
      revocations += 1
      return null
    },
  })

  const response = await app.inject({ method: 'DELETE', url: '/api/auth/session' })
  assert.equal(response.statusCode, 204)
  assert.equal(revocations, 0)
  assert.equal(response.headers['set-cookie'], undefined)
  await app.close()
})

test('revoking A immediately denies A while the newer session B stays active', async () => {
  const now = new Date()
  const rows = [
    { id: randomUUID(), familyId: randomUUID(), sessionId: SESSION_A, revokedAt: null as Date | null },
    { id: randomUUID(), familyId: randomUUID(), sessionId: SESSION_B, revokedAt: null as Date | null },
  ]
  const refreshToken = {
    findMany: async ({ where }: { where: { sessionId: string; userId: string } }) =>
      rows.filter((row) => where.userId === USER_ID && row.sessionId === where.sessionId),
    count: async ({ where }: { where: { familyId: { in: string[] }; revokedAt: null } }) =>
      rows.filter((row) => where.familyId.in.includes(row.familyId) && row.revokedAt === null).length,
    updateMany: async ({ where, data }: {
      where: { familyId: string; revokedAt: null }
      data: { revokedAt: Date }
    }) => {
      let count = 0
      for (const row of rows) {
        if (row.familyId === where.familyId && row.revokedAt === null) {
          row.revokedAt = data.revokedAt
          count += 1
        }
      }
      return { count }
    },
    findFirst: async ({ where }: {
      where: { expiresAt: { gt: Date }; revokedAt: null; sessionId: string; userId: string }
    }) => rows.find((row) =>
      row.sessionId === where.sessionId
      && row.revokedAt === null
      && where.userId === USER_ID) ?? null,
  }
  const revokedAuthSessions: Array<{ sessionId: string; userId: string }> = []
  const prisma = {
    refreshToken,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $queryRaw: async () => [{ locked: true }],
      authSession: {
        updateMany: async ({ where }: { where: { id: string; userId: string } }) => {
          revokedAuthSessions.push({ sessionId: where.id, userId: where.userId })
          return { count: 1 }
        },
      },
      refreshToken,
      uoaSessionCredential: { deleteMany: async () => ({ count: 0 }) },
    }),
  } as unknown as PrismaClient

  assert.equal(await revokeUserSession(prisma, USER_ID, SESSION_A), 1)
  assert.equal(await hasActiveUserSession(prisma, USER_ID, SESSION_A, now), false)
  assert.equal(await hasActiveUserSession(prisma, USER_ID, SESSION_B, now), true)
  // The AuthSession row for the targeted sid is revoked in the same transaction,
  // so its access JWT dies immediately rather than at TTL expiry (S9/SB-04).
  assert.deepEqual(revokedAuthSessions, [{ sessionId: SESSION_A, userId: USER_ID }])
})
