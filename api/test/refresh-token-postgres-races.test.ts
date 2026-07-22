import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  consumeRefreshToken,
  hashRefreshToken,
  issueRefreshToken,
  revokeRefreshTokenByRaw,
} from '../src/services/refresh-token.js'
import {
  revokeUserRefreshFamilies,
  sweepExpiredUoaSessionCredentials,
} from '../src/services/refresh-session-management.js'
import { lockUserSessions } from '../src/services/user-session-lock.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip
const AUTH_SECRET = 'postgres-refresh-race-secret'
const DAY_MS = 24 * 60 * 60 * 1_000

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const createPrincipal = async (prisma: PrismaClient) => {
  const organization = await prisma.organization.create({
    data: { name: `Refresh race ${randomUUID()}` },
  })
  const user = await prisma.user.create({
    data: {
      displayName: 'Refresh Race',
      email: `refresh-race-${randomUUID()}@example.com`,
      passwordHash: 'password-hash-v1',
      organizationMembers: {
        create: { organizationId: organization.id, role: 'owner' },
      },
    },
  })
  return { organizationId: organization.id, userId: user.id }
}

const issueUoaFamily = async (
  prisma: PrismaClient,
  principal: Awaited<ReturnType<typeof createPrincipal>>,
  refreshToken = `uoa-${randomUUID()}`,
  refreshTokenExpiresAt = new Date(Date.now() + 30 * DAY_MS),
) => issueRefreshToken(prisma, {
  encryptionSecret: AUTH_SECRET,
  organizationId: principal.organizationId,
  providerId: 'uoa',
  providerType: 'uoa',
  sessionId: randomUUID(),
  ttlSeconds: 3_600,
  userId: principal.userId,
  uoaSession: {
    configUrl: 'https://api.example.com/api/auth/sso/config',
    identity: {
      organizationId: 'uoa-org',
      subject: 'uoa-user',
      teamId: 'uoa-team',
      tokenVersion: 7,
    },
    refreshToken,
    refreshTokenExpiresAt,
  },
})

const rotate = (
  prisma: PrismaClient,
  rawToken: string,
  wait?: Promise<void>,
  entered?: () => void,
) => consumeRefreshToken(prisma, {
  authSecret: AUTH_SECRET,
  rawToken,
  ttlSeconds: 3_600,
  refreshUoaSession: async (input) => {
    entered?.()
    await wait
    return {
      identity: input.expectedIdentity,
      refreshToken: `${input.refreshToken}.next`,
      refreshTokenExpiresAt: new Date(Date.now() + 30 * DAY_MS),
    }
  },
})

runDatabaseTest('PostgreSQL refresh-family and user locks close cross-replica races', async (t) => {
  const prisma = new PrismaClient()
  const principal = await createPrincipal(prisma)
  t.after(async () => {
    await prisma.user.delete({ where: { id: principal.userId } }).catch(() => undefined)
    await prisma.organization.delete({
      where: { id: principal.organizationId },
    }).catch(() => undefined)
    await prisma.$disconnect()
  })

  await t.test('current rotation and ancestor replay return one exact successor', async () => {
    const first = await issueUoaFamily(prisma, principal)
    const second = await rotate(prisma, first.rawToken)
    assert.equal(second.ok, true)
    if (!second.ok) return

    const gate = deferred()
    const entered = deferred()
    const currentPromise = rotate(
      prisma,
      second.rawToken,
      gate.promise,
      entered.resolve,
    )
    await entered.promise
    const ancestorPromise = rotate(prisma, first.rawToken)
    gate.resolve()
    const [current, ancestor] = await Promise.all([currentPromise, ancestorPromise])
    assert.equal(current.ok, true)
    assert.equal(ancestor.ok, true)
    if (!current.ok || !ancestor.ok) return
    assert.equal(current.rawToken, ancestor.rawToken)

    const familyId = current.familyId
    assert.equal(await prisma.refreshToken.count({
      where: { familyId, revokedAt: null },
    }), 1)
    assert.equal(await prisma.uoaSessionCredential.count({
      where: { familyId },
    }), 1)
  })

  await t.test('logout waiting on rotation revokes its resulting successor', async () => {
    const issued = await issueUoaFamily(prisma, principal)
    const gate = deferred()
    const entered = deferred()
    const rotation = rotate(prisma, issued.rawToken, gate.promise, entered.resolve)
    await entered.promise
    const logout = revokeRefreshTokenByRaw(prisma, issued.rawToken)
    gate.resolve()
    const result = await rotation
    await logout
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(await prisma.refreshToken.count({
      where: { familyId: result.familyId, revokedAt: null },
    }), 0)
    assert.equal(await prisma.uoaSessionCredential.count({
      where: { familyId: result.familyId },
    }), 0)
  })

  await t.test('password update wins before stale verified issuance', async () => {
    const locked = deferred()
    const release = deferred()
    const passwordChange = prisma.$transaction(async (tx) => {
      await lockUserSessions(tx, principal.userId)
      locked.resolve()
      await release.promise
      await tx.user.update({
        where: { id: principal.userId },
        data: { passwordHash: 'password-hash-v2' },
      })
      await revokeUserRefreshFamilies(tx, { userId: principal.userId })
    })
    await locked.promise
    const issuance = issueRefreshToken(prisma, {
      expectedPasswordHash: 'password-hash-v1',
      organizationId: principal.organizationId,
      providerId: 'local',
      providerType: 'local',
      sessionId: randomUUID(),
      ttlSeconds: 3_600,
      userId: principal.userId,
    })
    release.resolve()
    await passwordChange
    await assert.rejects(issuance, /authenticated user state changed/)
  })

  await t.test('deactivation wins before an in-flight session issuance', async () => {
    const locked = deferred()
    const release = deferred()
    const deactivation = prisma.$transaction(async (tx) => {
      await lockUserSessions(tx, principal.userId)
      locked.resolve()
      await release.promise
      await tx.organizationMember.update({
        where: {
          organizationId_userId: {
            organizationId: principal.organizationId,
            userId: principal.userId,
          },
        },
        data: { deactivatedAt: new Date() },
      })
      await revokeUserRefreshFamilies(tx, { userId: principal.userId })
    })
    await locked.promise
    const issuance = issueRefreshToken(prisma, {
      organizationId: principal.organizationId,
      providerId: 'local',
      providerType: 'local',
      sessionId: randomUUID(),
      ttlSeconds: 3_600,
      userId: principal.userId,
    })
    release.resolve()
    await deactivation
    await assert.rejects(issuance, /authenticated user state changed/)
    await prisma.organizationMember.update({
      where: {
        organizationId_userId: {
          organizationId: principal.organizationId,
          userId: principal.userId,
        },
      },
      data: { deactivatedAt: null },
    })
  })

  await t.test('bounded expiry sweep erases encrypted state and retains history', async () => {
    const expiredAt = new Date(Date.now() - 1_000)
    const issued = await issueUoaFamily(
      prisma,
      principal,
      `expired-${randomUUID()}`,
      expiredAt,
    )
    const row = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(issued.rawToken) },
    })
    assert.ok((await sweepExpiredUoaSessionCredentials(prisma)) >= 1)
    assert.equal(await prisma.uoaSessionCredential.count({
      where: { familyId: row.familyId },
    }), 0)
    assert.equal(await prisma.refreshToken.count({
      where: { familyId: row.familyId },
    }), 1)
    assert.equal(await prisma.refreshToken.count({
      where: { familyId: row.familyId, revokedAt: null },
    }), 0)
  })
})
