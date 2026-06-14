import { createHash, randomBytes, randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

// Opaque refresh tokens are random 256-bit values. Only their SHA-256 hash is
// ever persisted; the raw value lives solely in the httpOnly cookie on the
// client, exactly like a password hash.
const generateRefreshTokenRaw = (): string => randomBytes(32).toString('base64url')

export const hashRefreshToken = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex')

const expiryFromNow = (ttlSeconds: number): Date =>
  new Date(Date.now() + ttlSeconds * 1000)

type IssueInput = {
  userId: string
  sessionId: string
  providerId: string
  providerType: string
  ttlSeconds: number
  familyId?: string
  userAgent?: string | null
}

// Mint a refresh token and store its hash. Omitting `familyId` starts a new
// rotation family (a fresh login); passing one continues an existing chain.
export const issueRefreshToken = async (
  prisma: PrismaClient,
  input: IssueInput,
): Promise<{ expiresAt: Date; rawToken: string }> => {
  const rawToken = generateRefreshTokenRaw()
  const expiresAt = expiryFromNow(input.ttlSeconds)
  await prisma.refreshToken.create({
    data: {
      userId: input.userId,
      sessionId: input.sessionId,
      providerId: input.providerId,
      providerType: input.providerType,
      familyId: input.familyId ?? randomUUID(),
      tokenHash: hashRefreshToken(rawToken),
      expiresAt,
      userAgent: input.userAgent ?? undefined,
    },
  })
  return { rawToken, expiresAt }
}

type ValidationResult =
  | {
      ok: true
      familyId: string
      recordId: string
      userId: string
      providerId: string
      providerType: string
    }
  | { ok: false; reason: 'expired' | 'invalid' | 'reuse' }

// Validate a presented refresh token without rotating it yet. Reuse of an
// already-revoked token means the family is compromised, so the whole family is
// revoked and the caller must reject (and clear the cookie).
export const validateRefreshToken = async (
  prisma: PrismaClient,
  rawToken: string,
): Promise<ValidationResult> => {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(rawToken) },
    select: {
      id: true,
      userId: true,
      familyId: true,
      providerId: true,
      providerType: true,
      revokedAt: true,
      expiresAt: true,
    },
  })

  if (!record) {
    return { ok: false, reason: 'invalid' }
  }

  if (record.revokedAt) {
    await revokeFamily(prisma, record.familyId)
    return { ok: false, reason: 'reuse' }
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' }
  }

  return {
    ok: true,
    recordId: record.id,
    userId: record.userId,
    familyId: record.familyId,
    providerId: record.providerId,
    providerType: record.providerType,
  }
}

type RotateInput = {
  previousId: string
  familyId: string
  userId: string
  sessionId: string
  providerId: string
  providerType: string
  ttlSeconds: number
  userAgent?: string | null
}

// Issue the successor token in a family and revoke the one just consumed,
// linking the two via `replacedById`. Both writes run in one transaction so a
// crash can never leave two live tokens or none.
export const rotateRefreshToken = async (
  prisma: PrismaClient,
  input: RotateInput,
): Promise<{ expiresAt: Date; rawToken: string }> => {
  const rawToken = generateRefreshTokenRaw()
  const expiresAt = expiryFromNow(input.ttlSeconds)

  await prisma.$transaction(async (tx) => {
    const successor = await tx.refreshToken.create({
      data: {
        userId: input.userId,
        sessionId: input.sessionId,
        providerId: input.providerId,
        providerType: input.providerType,
        familyId: input.familyId,
        tokenHash: hashRefreshToken(rawToken),
        expiresAt,
        userAgent: input.userAgent ?? undefined,
      },
      select: { id: true },
    })
    await tx.refreshToken.update({
      where: { id: input.previousId },
      data: { revokedAt: new Date(), replacedById: successor.id },
    })
  })

  return { rawToken, expiresAt }
}

// Revoke every still-live token in a family. Used on reuse detection and logout.
export const revokeFamily = async (prisma: PrismaClient, familyId: string): Promise<void> => {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

// Logout: revoke the family of the presented token. Missing/unknown tokens are
// a no-op so logout is always idempotent.
export const revokeRefreshTokenByRaw = async (
  prisma: PrismaClient,
  rawToken: string,
): Promise<void> => {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(rawToken) },
    select: { familyId: true },
  })
  if (record) {
    await revokeFamily(prisma, record.familyId)
  }
}

export type UserSession = {
  sessionId: string
  userAgent: string | null
  createdAt: Date
  lastUsedAt: Date
  expiresAt: Date
}

// Active sessions for a user: one entry per `sessionId`, collapsed from that
// session's live refresh-token rotation chain (non-revoked, unexpired).
// `createdAt` is the first token in the chain; `lastUsedAt` the most recent.
export const listUserSessions = async (
  prisma: PrismaClient,
  userId: string,
): Promise<UserSession[]> => {
  const tokens = await prisma.refreshToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { sessionId: true, userAgent: true, createdAt: true, expiresAt: true },
    orderBy: { createdAt: 'asc' },
  })

  const bySession = new Map<string, UserSession>()
  for (const token of tokens) {
    const existing = bySession.get(token.sessionId)
    if (!existing) {
      bySession.set(token.sessionId, {
        sessionId: token.sessionId,
        userAgent: token.userAgent,
        createdAt: token.createdAt,
        lastUsedAt: token.createdAt,
        expiresAt: token.expiresAt,
      })
      continue
    }
    existing.lastUsedAt = token.createdAt
    existing.expiresAt = token.expiresAt
    if (!existing.userAgent && token.userAgent) {
      existing.userAgent = token.userAgent
    }
  }

  return Array.from(bySession.values()).sort(
    (left, right) => right.lastUsedAt.getTime() - left.lastUsedAt.getTime(),
  )
}

// Revoke a single session (all its live refresh tokens), scoped by `userId` so a
// caller can only revoke their own sessions. Returns the number of tokens
// revoked (0 when the session isn't theirs or is already gone).
export const revokeUserSession = async (
  prisma: PrismaClient,
  userId: string,
  sessionId: string,
): Promise<number> => {
  const result = await prisma.refreshToken.updateMany({
    where: { userId, sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return result.count
}
