import type { Prisma, PrismaClient } from '@prisma/client'
import {
  lockRefreshFamily,
  revokeRefreshFamilyRows,
} from './refresh-token-family.js'
import {
  AUTH_LOCK_TRANSACTION_OPTIONS,
  lockUserSessions,
} from './user-session-lock.js'

export type UserSession = {
  sessionId: string
  userAgent: string | null
  createdAt: Date
  lastUsedAt: Date
  expiresAt: Date
}

const EXPIRED_CREDENTIAL_SWEEP_BATCH = 100

/** Remove expired encrypted UOA credentials without deleting token history. */
export const sweepExpiredUoaSessionCredentials = async (
  prisma: PrismaClient,
  now = new Date(),
): Promise<number> => {
  const candidates = await prisma.uoaSessionCredential.findMany({
    where: {
      OR: [
        { refreshTokenExpiresAt: { lte: now } },
        { lastLocalToken: { expiresAt: { lte: now } } },
      ],
    },
    orderBy: { refreshTokenExpiresAt: 'asc' },
    select: { familyId: true },
    take: EXPIRED_CREDENTIAL_SWEEP_BATCH,
  })
  let swept = 0
  for (const candidate of candidates) {
    swept += await prisma.$transaction(async (tx) => {
      await lockRefreshFamily(tx, candidate.familyId)
      const credential = await tx.uoaSessionCredential.findUnique({
        where: { familyId: candidate.familyId },
        select: {
          refreshTokenExpiresAt: true,
          lastLocalToken: { select: { expiresAt: true } },
        },
      })
      if (
        !credential
        || (
          credential.refreshTokenExpiresAt.getTime() > now.getTime()
          && credential.lastLocalToken.expiresAt.getTime() > now.getTime()
        )
      ) {
        return 0
      }
      await revokeRefreshFamilyRows(tx, candidate.familyId, now)
      return 1
    }, AUTH_LOCK_TRANSACTION_OPTIONS)
  }
  return swept
}

type SessionAccumulator = UserSession & { active: boolean }

/** List one active entry per stable local session id. */
export const listUserSessions = async (
  prisma: PrismaClient,
  userId: string,
): Promise<UserSession[]> => {
  const now = Date.now()
  const tokens = await prisma.refreshToken.findMany({
    where: { userId },
    select: {
      sessionId: true,
      userAgent: true,
      createdAt: true,
      expiresAt: true,
      revokedAt: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  const bySession = new Map<string, SessionAccumulator>()
  for (const token of tokens) {
    const live = !token.revokedAt && token.expiresAt.getTime() > now
    const existing = bySession.get(token.sessionId)
    if (!existing) {
      bySession.set(token.sessionId, {
        sessionId: token.sessionId,
        userAgent: token.userAgent,
        createdAt: token.createdAt,
        lastUsedAt: token.createdAt,
        expiresAt: token.expiresAt,
        active: live,
      })
      continue
    }
    existing.lastUsedAt = token.createdAt
    existing.expiresAt = token.expiresAt
    if (token.userAgent) existing.userAgent = token.userAgent
    if (live) existing.active = true
  }

  return Array.from(bySession.values())
    .filter((entry) => entry.active)
    .map(
      (entry): UserSession => ({
        sessionId: entry.sessionId,
        userAgent: entry.userAgent,
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt,
        expiresAt: entry.expiresAt,
      }),
    )
    .sort((left, right) => right.lastUsedAt.getTime() - left.lastUsedAt.getTime())
}

/** Prove that this exact bearer session still has a live refresh row. */
export const hasActiveUserSession = async (
  prisma: PrismaClient,
  userId: string,
  sessionId: string,
  now = new Date(),
): Promise<boolean> => Boolean(await prisma.refreshToken.findFirst({
  where: {
    userId,
    sessionId,
    revokedAt: null,
    expiresAt: { gt: now },
  },
  select: { id: true },
}))

/** Revoke one local session and erase any bound encrypted UOA credentials. */
export const revokeUserSession = async (
  prisma: PrismaClient,
  userId: string,
  sessionId: string,
): Promise<number> => prisma.$transaction(async (tx) => {
  await lockUserSessions(tx, userId)
  const families = await tx.refreshToken.findMany({
    where: { userId, sessionId },
    select: { familyId: true },
    distinct: ['familyId'],
  })
  const familyIds = families.map((row) => row.familyId).sort()
  for (const familyId of familyIds) {
    await lockRefreshFamily(tx, familyId)
  }
  const now = new Date()
  const activeCount = await tx.refreshToken.count({
    where: {
      expiresAt: { gt: now },
      familyId: { in: familyIds },
      revokedAt: null,
      userId,
    },
  })
  for (const familyId of familyIds) {
    await revokeRefreshFamilyRows(tx, familyId, now)
  }
  return activeCount
}, AUTH_LOCK_TRANSACTION_OPTIONS)

type RefreshSessionTransaction = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'refreshToken' | 'uoaSessionCredential'
>

/** Revoke matching local families and erase their encrypted UOA credentials. */
export const revokeUserRefreshFamilies = async (
  tx: RefreshSessionTransaction,
  input: { exceptSessionId?: string | null; userId: string },
): Promise<number> => {
  await lockUserSessions(tx, input.userId)
  const sessionFilter = input.exceptSessionId
    ? { sessionId: { not: input.exceptSessionId } }
    : {}
  const families = await tx.refreshToken.findMany({
    where: { userId: input.userId, ...sessionFilter },
    select: { familyId: true },
    distinct: ['familyId'],
  })
  const familyIds = families.map((row) => row.familyId).sort()
  for (const familyId of familyIds) {
    await lockRefreshFamily(tx, familyId)
  }
  const activeCount = await tx.refreshToken.count({
    where: {
      familyId: { in: familyIds },
      userId: input.userId,
      revokedAt: null,
    },
  })
  const now = new Date()
  for (const familyId of familyIds) {
    await revokeRefreshFamilyRows(tx, familyId, now)
  }
  return activeCount
}

/** Security-sensitive user-wide revocation with credential erasure atomic. */
export const revokeOtherUserSessions = async (
  prisma: PrismaClient,
  input: { currentSessionId?: string | null; userId: string },
): Promise<number> => prisma.$transaction((tx) =>
  revokeUserRefreshFamilies(tx, {
    exceptSessionId: input.currentSessionId,
    userId: input.userId,
  }), AUTH_LOCK_TRANSACTION_OPTIONS)
