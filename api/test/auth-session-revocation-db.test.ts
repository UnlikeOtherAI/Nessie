import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import Fastify from 'fastify'
import type { FastifyRequest, FastifyReply } from 'fastify'

import {
  issueSessionToken,
  verifySessionToken,
} from '../src/auth/session.js'
import { hashPassword } from '../src/auth/password.js'
import { createAuthSessionRevocationChecker } from '../src/services/auth-session-registry.js'
import { hasActiveUserSession } from '../src/services/refresh-session-management.js'
import { registerAuthSecurityRoutes } from '../src/routes/auth-security.js'
import { registerGlobalAuthHook } from '../src/lib/global-auth-hook.js'
import { RateLimiter } from '../src/services/rate-limit.js'
import type { RouteDeps } from '../src/routes/types.js'

/**
 * S9/SB-04 workstream 1e: the AuthSession row is the revocation authority for
 * a login session, and central auth rejects a token whose sid carries a
 * revokedAt. Exercised against a real database through the REAL
 * authenticateRequest wiring, because every guarantee here is a database
 * guarantee (the row write at issuance, the revoke write in the same
 * transaction as the family revocation, and the fail-open-on-absence rule).
 *
 * Seed-scoped: every row is created under ids unique to this suite and
 * removed after each test, because these suites share one database and run
 * concurrently (AGENTS.md → Workflow).
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

const AUTH_SECRET = 'session-revocation-test-secret'

const suite = '5b04'
const organizationId = `00000000-0000-4000-8000-${suite}00000001`
const projectId = `00000000-0000-4000-8000-${suite}00000002`
const teamId = `00000000-0000-4000-8000-${suite}00000003`
const userId = `00000000-0000-4000-8000-${suite}00000004`

const rateLimitRule = { max: 1000, windowMs: 10 * 60_000 }

const claimsFor = (sid: string) => ({
  org: organizationId,
  proj: projectId,
  providerId: 'local',
  providerType: 'local-bootstrap' as const,
  roles: ['owner'],
  sub: userId,
  team: teamId,
  tv: 0,
})

const bearerFor = (sid: string, ttlSeconds = 3600): string => issueSessionToken(
  claimsFor(sid),
  AUTH_SECRET,
  ttlSeconds,
  sid,
).token

const seedRefreshRow = async (
  prisma: PrismaClient,
  sessionId: string,
  overrides: { revokedAt?: Date } = {},
) => prisma.refreshToken.create({
  data: {
    userId,
    familyId: sessionId,
    sessionId,
    providerId: 'local',
    providerType: 'local-bootstrap',
    tokenHash: `hash-${sessionId}`,
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: overrides.revokedAt ?? null,
  },
})

const seed = async (prisma: PrismaClient, password: string) => {
  await prisma.organization.create({
    data: { id: organizationId, name: `sb04-${suite}` },
  })
  await prisma.user.create({
    data: {
      id: userId,
      email: `sb04-${suite}@test.local`,
      displayName: 'SB04',
      passwordHash: await hashPassword(password),
    },
  })
  await prisma.organizationMember.create({
    data: { organizationId, role: 'owner', userId },
  })
  await prisma.project.create({
    data: { id: projectId, name: `p-${suite}`, organizationId },
  })
  await prisma.team.create({
    data: { id: teamId, name: `t-${suite}`, projectId },
  })
}

const cleanup = async (prisma: PrismaClient) => {
  await prisma.authSession.deleteMany({ where: { userId } })
  await prisma.refreshToken.deleteMany({ where: { userId } })
  await prisma.organizationMember.deleteMany({ where: { userId } })
  await prisma.team.deleteMany({ where: { id: teamId } })
  await prisma.project.deleteMany({ where: { id: projectId } })
  await prisma.user.deleteMany({ where: { id: userId } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
}

/**
 * A minimal Fastify app running the authenticateRequest flow — the same
 * checks server-context performs, including the AuthSession revocation gate —
 * in front of the REAL auth-security routes. requireActorContext mirrors the
 * production contract: the hook stores the context on request.actorContext
 * and the routes read it back from there.
 */
const buildAppWithActor = (prisma: PrismaClient) => {
  const isSessionRevokedById = createAuthSessionRevocationChecker(prisma)

  const authenticateRequest = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const header = request.headers.authorization
    const token = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : null
    if (!token) {
      reply.code(401).send({ error: { code: 'AUTH_REQUIRED' } })
      return null
    }
    const verification = verifySessionToken(token, AUTH_SECRET)
    if (!verification.ok) {
      reply.code(401).send({ error: { code: verification.code } })
      return null
    }
    const user = await prisma.user.findUnique({
      where: { id: verification.claims.sub },
    })
    if (!user) {
      reply.code(401).send({ error: { code: 'USER_NOT_FOUND' } })
      return null
    }
    if (await isSessionRevokedById(verification.claims.sid)) {
      reply.code(401).send({ error: { code: 'TOKEN_REVOKED' } })
      return null
    }
    if (
      !(await hasActiveUserSession(
        prisma,
        verification.claims.sub,
        verification.claims.sid,
      ))
    ) {
      reply.code(401).send({ error: { code: 'TOKEN_REVOKED' } })
      return null
    }
    const actorContext = {
      actor: { actorId: user.id, actorType: 'user', roles: ['owner'] },
      tenant: { organizationId },
    }
    // Mirror the production wiring: the hook stores the context on the request
    // and requireActorContext reads it back.
    ;(request as unknown as { actorContext: unknown }).actorContext = actorContext
    return { actorContext, claims: verification.claims, me: { user: { id: user.id } } }
  }

  const app = Fastify({ logger: false })
  registerGlobalAuthHook(app, {
    authenticateRequest: authenticateRequest as never,
    checkRateLimit: () => null,
    prisma,
  })
  registerAuthSecurityRoutes(
    app,
    {
      authSecret: AUTH_SECRET,
      buildSessionForUser: (() => {
        throw new Error('not used by this suite')
      }) as never,
      config: {
        mode: 'local',
        api: { rateLimit: { stepUpIp: rateLimitRule, stepUpAccount: rateLimitRule } },
      },
      getAuthorizationToken: (request: FastifyRequest) =>
        typeof request.headers.authorization === 'string'
          ? request.headers.authorization.replace(/^Bearer /, '')
          : null,
      prisma,
      rateLimiter: new RateLimiter(prisma, { error: () => {} } as never),
      requireActorContext: (request: FastifyRequest, reply: FastifyReply) => {
        const ctx = (request as unknown as { actorContext?: unknown }).actorContext
        if (!ctx) {
          reply.code(401).send({ error: { code: 'AUTH_REQUIRED' } })
          return null
        }
        return ctx as never
      },
    } as unknown as RouteDeps,
    (async () => {}) as never,
  )
  return { app }
}

const withDb = async (
  password: string,
  run: (prisma: PrismaClient) => Promise<void>,
) => {
  const prisma = new PrismaClient()
  try {
    await cleanup(prisma)
    await seed(prisma, password)
    await run(prisma)
  } finally {
    await cleanup(prisma)
    await prisma.$disconnect()
  }
}

const PASSWORD = 'old-password-1234'

// ─── 1. DELETE /api/auth/sessions/:sessionId ────────────────────────────────

dbTest('revoking a session rejects its access token on the next request', async () => {
  await withDb(PASSWORD, async (prisma) => {
    const victimSid = crypto.randomUUID()
    const keeperSid = crypto.randomUUID()
    await seedRefreshRow(prisma, victimSid)
    await seedRefreshRow(prisma, keeperSid)
    // The issuance upsert: both sids exist as live AuthSession rows.
    await prisma.authSession.createMany({
      data: [
        { id: victimSid, userId },
        { id: keeperSid, userId },
      ],
    })

    const { app } = buildAppWithActor(prisma)
    const victimToken = bearerFor(victimSid)
    const keeperToken = bearerFor(keeperSid)

    // Sanity: both sessions authenticate before the revoke.
    const before = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { authorization: `Bearer ${victimToken}` },
    })
    assert.equal(before.statusCode, 200, before.body)

    // The keeper (the "current" session) deletes the victim.
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${victimSid}`,
      headers: { authorization: `Bearer ${keeperToken}` },
    })
    assert.equal(deleted.statusCode, 200, deleted.body)

    // The victim's still-valid, still-signed access token is now rejected.
    const after = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { authorization: `Bearer ${victimToken}` },
    })
    assert.equal(after.statusCode, 401, after.body)
    assert.match(after.body, /TOKEN_REVOKED/)

    // The keeper's token still works.
    const keeperAfter = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { authorization: `Bearer ${keeperToken}` },
    })
    assert.equal(keeperAfter.statusCode, 200, keeperAfter.body)

    // The row carries the revocation timestamp.
    const row = await prisma.authSession.findUnique({ where: { id: victimSid } })
    assert.ok(row?.revokedAt, 'expected AuthSession.revokedAt to be set')
    await app.close()
  })
})

// ─── 2. Fail-open on absence ────────────────────────────────────────────────

dbTest('a sid with no AuthSession row still authenticates (rollout safety)', async () => {
  await withDb(PASSWORD, async (prisma) => {
    const legacySid = crypto.randomUUID()
    await seedRefreshRow(prisma, legacySid)
    // Deliberately NO AuthSession row: pre-migration tokens and any issuance
    // path not yet writing rows must keep working until issuance coverage is
    // proven — the check fails closed only on an explicit revoked row.
    const { app } = buildAppWithActor(prisma)
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { authorization: `Bearer ${bearerFor(legacySid)}` },
    })
    assert.equal(response.statusCode, 200, response.body)
    await app.close()
  })
})

// ─── 3. Password change ─────────────────────────────────────────────────────

dbTest('password change revokes other sessions but not the current one', async () => {
  await withDb(PASSWORD, async (prisma) => {
    const currentSid = crypto.randomUUID()
    const otherSid = crypto.randomUUID()
    await seedRefreshRow(prisma, currentSid)
    await seedRefreshRow(prisma, otherSid)
    await prisma.authSession.createMany({
      data: [
        { id: currentSid, userId },
        { id: otherSid, userId },
      ],
    })

    const { app } = buildAppWithActor(prisma)
    const currentToken = bearerFor(currentSid)
    const otherToken = bearerFor(otherSid)

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { authorization: `Bearer ${currentToken}` },
      payload: { currentPassword: PASSWORD, newPassword: 'new-password-5678' },
    })
    assert.equal(changed.statusCode, 200, changed.body)

    // The other session's access token is rejected.
    const other = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { authorization: `Bearer ${otherToken}` },
    })
    assert.equal(other.statusCode, 401, other.body)
    assert.match(other.body, /TOKEN_REVOKED/)

    // The current session — the one that proved the password — stays live.
    const current = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { authorization: `Bearer ${currentToken}` },
    })
    assert.equal(current.statusCode, 200, current.body)

    const rows = await prisma.authSession.findMany({
      where: { userId },
      orderBy: { id: 'asc' },
    })
    const bySid = new Map(rows.map((row) => [row.id, row]))
    assert.equal(bySid.get(currentSid)?.revokedAt, null)
    assert.ok(bySid.get(otherSid)?.revokedAt)
    await app.close()
  })
})

// ─── Isolation probe: the AuthSession gate alone rejects ────────────────────

dbTest('a revoked AuthSession row alone rejects the token (refresh rows stay live)', async () => {
  await withDb(PASSWORD, async (prisma) => {
    const sid = crypto.randomUUID()
    await seedRefreshRow(prisma, sid)
    await prisma.authSession.create({ data: { id: sid, userId, revokedAt: new Date() } })
    // The refresh row is still unrevoked and unexpired, so hasActiveUserSession
    // would PASS; only the AuthSession gate can reject this request.
    const { app } = buildAppWithActor(prisma)
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { authorization: `Bearer ${bearerFor(sid)}` },
    })
    assert.equal(response.statusCode, 401, response.body)
    assert.match(response.body, /TOKEN_REVOKED/)
    await app.close()
  })
})
