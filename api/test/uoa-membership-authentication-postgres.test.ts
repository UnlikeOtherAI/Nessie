import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { FastifyReply, FastifyRequest } from 'fastify'
import { PrismaClient } from '@prisma/client'

/**
 * What an absent or deactivated `OrganizationMember` row means on a request,
 * through the REAL `authenticateRequest` (2026-09-05 API review, FO2-1).
 *
 * The row is the live authorization: `authenticateRequest` re-resolves
 * `actor.roles` from it. An absent row used to pass through unconditionally, so
 * a membership UOA had withdrawn — and which
 * `reconcileUoaMembershipProjection` now removes — kept authorizing requests
 * until the access token expired. Inside a UOA-bound organisation that is now a
 * refusal; inside an unbound one the pass-through survives, because a local
 * install legitimately holds sessions with no membership row (the bootstrap
 * fallback in `services/session-issuers.ts`).
 *
 * Database-backed through the real wiring, because a fake would assert the
 * lookup rather than the rows it finds.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

const AUTH_SECRET = 'uoa-membership-authentication-test-secret'
process.env.NESSIE_AUTH_SECRET ??= AUTH_SECRET

const { issueSessionToken } = await import('../src/auth/session.js')
const { createServerContext } = await import('../src/lib/server-context.js')

type Reply = {
  body: { error?: { code?: string } } | undefined
  statusCode: number | undefined
}

const replyDouble = (): Reply & FastifyReply => {
  const state: Reply = { body: undefined, statusCode: undefined }
  const reply = {
    ...state,
    code(statusCode: number) {
      ;(this as unknown as Reply).statusCode = statusCode
      return this
    },
    send(body: unknown) {
      ;(this as unknown as Reply).body = body as Reply['body']
      return this
    },
  }
  return reply as unknown as Reply & FastifyReply
}

type Seed = {
  organizationId: string
  projectId: string
  teamId: string
  token: string
  userId: string
}

const seed = async (
  prisma: PrismaClient,
  input: { authSecret: string; externalOrgId: string | null; withMembership: boolean },
): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: {
      name: `auth-${suffix}`,
      ...(input.externalOrgId ? { externalOrgId: input.externalOrgId } : {}),
    },
  })
  const project = await prisma.project.create({
    data: { name: `auth-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `auth-${suffix}`, projectId: project.id },
  })
  const user = await prisma.user.create({
    data: { email: `auth-${suffix}@test.local`, displayName: 'Auth' },
  })
  if (input.withMembership) {
    await prisma.organizationMember.create({
      data: { organizationId: organization.id, role: 'owner', userId: user.id },
    })
  }

  const issued = issueSessionToken(
    {
      org: organization.id,
      proj: project.id,
      providerId: 'local',
      providerType: 'local-bootstrap',
      roles: ['owner'],
      sub: user.id,
      team: team.id,
      tv: 0,
    },
    input.authSecret,
    3600,
  )
  // `hasActiveUserSession` is a live check against the refresh family, so the
  // session has to exist as a row for the request to reach the membership gate.
  await prisma.refreshToken.create({
    data: {
      expiresAt: new Date(Date.now() + 86_400_000),
      familyId: issued.sessionId,
      providerId: 'local',
      providerType: 'local-bootstrap',
      sessionId: issued.sessionId,
      tokenHash: `hash-${suffix}`,
      userId: user.id,
    },
  })

  return {
    organizationId: organization.id,
    projectId: project.id,
    teamId: team.id,
    token: issued.token,
    userId: user.id,
  }
}

const authenticate = async (
  context: ReturnType<typeof createServerContext>,
  token: string,
): Promise<{ reply: Reply; state: unknown }> => {
  const request = {
    headers: { authorization: `Bearer ${token}` },
    query: {},
  } as unknown as FastifyRequest
  const reply = replyDouble()
  const state = await context.authenticateRequest(request, reply)
  return { reply: reply as unknown as Reply, state }
}

const withContext = async (
  input: { externalOrgId: string | null; withMembership: boolean },
  run: (
    context: ReturnType<typeof createServerContext>,
    prisma: PrismaClient,
    seeded: Seed,
  ) => Promise<void>,
): Promise<void> => {
  const context = createServerContext()
  const prisma = new PrismaClient()
  const seeded = await seed(prisma, { ...input, authSecret: context.authSecret })
  try {
    await run(context, prisma, seeded)
  } finally {
    await prisma.refreshToken.deleteMany({ where: { userId: seeded.userId } })
    await prisma.user.deleteMany({ where: { id: seeded.userId } })
    await prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
    await prisma.$disconnect()
    await context.disconnectPrismaClient()
  }
}

dbTest('a UOA-bound organisation refuses a session with no membership row', async () => {
  await withContext(
    { externalOrgId: `uoa-org-auth-${randomUUID()}`, withMembership: false },
    async (context, _prisma, seeded) => {
      const { reply, state } = await authenticate(context, seeded.token)

      assert.equal(state, null)
      assert.equal(reply.statusCode, 403)
      assert.equal(reply.body?.error?.code, 'ORGANIZATION_MEMBERSHIP_REQUIRED')
    },
  )
})

dbTest('a UOA-bound organisation refuses a deactivated membership', async () => {
  await withContext(
    { externalOrgId: `uoa-org-auth-${randomUUID()}`, withMembership: true },
    async (context, prisma, seeded) => {
      const allowed = await authenticate(context, seeded.token)
      assert.notEqual(allowed.state, null, 'a live membership authenticates')

      await prisma.organizationMember.updateMany({
        where: { organizationId: seeded.organizationId, userId: seeded.userId },
        data: { deactivatedAt: new Date() },
      })

      const { reply, state } = await authenticate(context, seeded.token)
      assert.equal(state, null)
      assert.equal(reply.statusCode, 403)
      assert.equal(reply.body?.error?.code, 'ACCOUNT_DEACTIVATED')
    },
  )
})

dbTest('an unbound organisation still passes an absent membership through', async () => {
  await withContext(
    { externalOrgId: null, withMembership: false },
    async (context, _prisma, seeded) => {
      const { reply, state } = await authenticate(context, seeded.token)

      assert.equal(reply.statusCode, undefined, 'nothing was refused')
      assert.notEqual(state, null)
    },
  )
})
