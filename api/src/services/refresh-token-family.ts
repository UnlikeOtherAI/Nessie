import { Prisma, type PrismaClient } from '@prisma/client'

import {
  deriveRefreshTokenSuccessor,
  hashRefreshToken,
} from './refresh-token-crypto.js'
import { AUTH_LOCK_TRANSACTION_OPTIONS } from './user-session-lock.js'

const MAX_REFRESH_REPLAY_CHAIN_DEPTH = 32

export const REFRESH_TOKEN_REPLAY_GRACE_MS = 60_000

export type RefreshTokenRecord = {
  id: string
  userId: string
  familyId: string
  sessionId: string
  providerId: string
  providerType: string
  tokenHash: string
  revokedAt: Date | null
  replacedById: string | null
  replayProtectedUntil: Date | null
  expiresAt: Date
}

export const refreshTokenSelect = {
  id: true,
  userId: true,
  familyId: true,
  sessionId: true,
  providerId: true,
  providerType: true,
  tokenHash: true,
  revokedAt: true,
  replacedById: true,
  replayProtectedUntil: true,
  expiresAt: true,
} as const

type RefreshFamilyStore = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'refreshToken' | 'uoaSessionCredential'
>

export type ReplayResolution =
  | { ok: true; rawToken: string; record: RefreshTokenRecord }
  | { ok: false; reason: 'expired' | 'reuse' }

const sameRotationFamily = (
  left: RefreshTokenRecord,
  right: RefreshTokenRecord,
): boolean =>
  left.familyId === right.familyId
  && left.userId === right.userId
  && left.sessionId === right.sessionId
  && left.providerId === right.providerId
  && left.providerType === right.providerType

/** Serialize every decision for one refresh family across all API replicas. */
export const lockRefreshFamily = async (
  tx: RefreshFamilyStore,
  familyId: string,
): Promise<void> => {
  await tx.$queryRaw(Prisma.sql`
    SELECT 1
    FROM (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`nessie:refresh-family:${familyId}`}, 0)
      )
    ) AS acquired
  `)
}

/** Caller must already hold the family's transaction-scoped advisory lock. */
export const revokeRefreshFamilyRows = async (
  tx: RefreshFamilyStore,
  familyId: string,
  now: Date,
): Promise<void> => {
  await tx.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: now },
  })
  await tx.uoaSessionCredential.deleteMany({ where: { familyId } })
}

/** Revoke every still-live token and upstream credential in one family. */
export const revokeRefreshFamily = async (
  prisma: PrismaClient,
  familyId: string,
): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    await lockRefreshFamily(tx, familyId)
    await revokeRefreshFamilyRows(tx, familyId, new Date())
  }, AUTH_LOCK_TRANSACTION_OPTIONS)
}

const rejectReuse = async (
  tx: RefreshFamilyStore,
  familyId: string,
  now: Date,
): Promise<ReplayResolution> => {
  await revokeRefreshFamilyRows(tx, familyId, now)
  return { ok: false, reason: 'reuse' }
}

/**
 * Follow and cryptographically verify a deterministic replacement chain.
 * Accepted predecessor replay protects the live descendant for another grace
 * interval, so a concurrently submitted current cookie returns that same value
 * regardless of request or HTTP-response ordering.
 */
export const resolveReplayDescendant = async (
  tx: RefreshFamilyStore,
  input: {
    authSecret: string
    now: Date
    root: RefreshTokenRecord
    rootRawToken: string
  },
): Promise<ReplayResolution> => {
  const { authSecret, now, root, rootRawToken } = input
  if (
    !root.revokedAt
    || now.getTime() - root.revokedAt.getTime() > REFRESH_TOKEN_REPLAY_GRACE_MS
  ) {
    return rejectReuse(tx, root.familyId, now)
  }

  let current = root
  let currentRawToken = rootRawToken
  const seen = new Set([root.id])
  let depth = 0

  while (current.revokedAt) {
    if (
      depth >= MAX_REFRESH_REPLAY_CHAIN_DEPTH
      || !current.replacedById
      || seen.has(current.replacedById)
    ) {
      return rejectReuse(tx, root.familyId, now)
    }
    depth += 1

    const successorRawToken = deriveRefreshTokenSuccessor(currentRawToken, authSecret)
    const successor = await tx.refreshToken.findUnique({
      where: { id: current.replacedById },
      select: refreshTokenSelect,
    }) as RefreshTokenRecord | null
    if (
      !successor
      || successor.tokenHash !== hashRefreshToken(successorRawToken)
      || !sameRotationFamily(root, successor)
    ) {
      return rejectReuse(tx, root.familyId, now)
    }

    seen.add(successor.id)
    current = successor
    currentRawToken = successorRawToken
  }

  if (current.replacedById) {
    return rejectReuse(tx, root.familyId, now)
  }
  if (current.expiresAt.getTime() <= now.getTime()) {
    await revokeRefreshFamilyRows(tx, current.familyId, now)
    return { ok: false, reason: 'expired' }
  }

  const replayProtectedUntil = new Date(
    now.getTime() + REFRESH_TOKEN_REPLAY_GRACE_MS,
  )
  const protectedToken = await tx.refreshToken.updateMany({
    where: {
      id: current.id,
      revokedAt: null,
      replacedById: null,
    },
    data: { replayProtectedUntil },
  })
  if (protectedToken.count !== 1) {
    return rejectReuse(tx, root.familyId, now)
  }

  return {
    ok: true,
    rawToken: currentRawToken,
    record: { ...current, replayProtectedUntil },
  }
}

export type RefreshFamilyPrisma = Pick<
  PrismaClient,
  '$transaction' | 'refreshToken' | 'uoaSessionCredential'
>
