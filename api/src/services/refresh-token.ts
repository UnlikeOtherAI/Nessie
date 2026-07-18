import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

// Opaque refresh tokens are random 256-bit values. Only their SHA-256 hash is
// ever persisted; the raw value lives solely in the httpOnly cookie on the
// client, exactly like a password hash.
const generateRefreshTokenRaw = (): string => randomBytes(32).toString('base64url')

const SUCCESSOR_HMAC_DOMAIN = 'nessie.refresh-token.successor.v1\u0000'
const MAX_REFRESH_REPLAY_CHAIN_DEPTH = 32

// A refresh response can be lost, or two WebView lifecycles can briefly submit
// the same cookie. During this narrow window the deterministic successor lets
// both requests receive the same live token without persisting its plaintext.
export const REFRESH_TOKEN_REPLAY_GRACE_MS = 60_000

export const hashRefreshToken = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex')

const deriveRefreshTokenSuccessor = (rawToken: string, authSecret: string): string =>
  createHmac('sha256', authSecret)
    .update(SUCCESSOR_HMAC_DOMAIN)
    .update(rawToken)
    .digest('base64url')

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

type RefreshTokenRecord = {
  id: string
  userId: string
  familyId: string
  sessionId: string
  providerId: string
  providerType: string
  tokenHash: string
  revokedAt: Date | null
  replacedById: string | null
  expiresAt: Date
}

export type ConsumeRefreshTokenResult =
  | {
      ok: true
      expiresAt: Date
      familyId: string
      rawToken: string
      replayed: boolean
      sessionId: string
      userId: string
      providerId: string
      providerType: string
    }
  | { ok: false; reason: 'expired' | 'invalid' | 'reuse' }

type ConsumeInput = {
  authSecret: string
  rawToken: string
  ttlSeconds: number
  userAgent?: string | null
  now?: Date
}

const refreshTokenSelect = {
  id: true,
  userId: true,
  familyId: true,
  sessionId: true,
  providerId: true,
  providerType: true,
  tokenHash: true,
  revokedAt: true,
  replacedById: true,
  expiresAt: true,
} as const

const sameRotationFamily = (left: RefreshTokenRecord, right: RefreshTokenRecord): boolean =>
  left.familyId === right.familyId
  && left.userId === right.userId
  && left.sessionId === right.sessionId
  && left.providerId === right.providerId
  && left.providerType === right.providerType

const successResult = (
  record: RefreshTokenRecord,
  rawToken: string,
  replayed: boolean,
): ConsumeRefreshTokenResult => ({
  ok: true,
  expiresAt: record.expiresAt,
  familyId: record.familyId,
  rawToken,
  replayed,
  sessionId: record.sessionId,
  userId: record.userId,
  providerId: record.providerId,
  providerType: record.providerType,
})

const rejectTokenReuse = async (
  prisma: PrismaClient,
  familyId: string,
): Promise<ConsumeRefreshTokenResult> => {
  await revokeFamily(prisma, familyId)
  return { ok: false, reason: 'reuse' }
}

// Follow the deterministic replacement chain to the current live descendant.
// Every link is verified against both its database id and derived token hash so
// a corrupt/cross-family pointer can never turn into a valid refresh token.
const resolveReplayDescendant = async (
  prisma: PrismaClient,
  root: RefreshTokenRecord,
  rootRawToken: string,
  authSecret: string,
  now: Date,
): Promise<ConsumeRefreshTokenResult> => {
  if (
    !root.revokedAt
    || now.getTime() - root.revokedAt.getTime() > REFRESH_TOKEN_REPLAY_GRACE_MS
  ) {
    return rejectTokenReuse(prisma, root.familyId)
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
      return rejectTokenReuse(prisma, root.familyId)
    }
    depth += 1

    const successorRawToken = deriveRefreshTokenSuccessor(currentRawToken, authSecret)
    const successor = await prisma.refreshToken.findUnique({
      where: { id: current.replacedById },
      select: refreshTokenSelect,
    }) as RefreshTokenRecord | null

    if (
      !successor
      || successor.tokenHash !== hashRefreshToken(successorRawToken)
      || !sameRotationFamily(root, successor)
    ) {
      return rejectTokenReuse(prisma, root.familyId)
    }

    seen.add(successor.id)
    current = successor
    currentRawToken = successorRawToken
  }

  if (current.replacedById) {
    return rejectTokenReuse(prisma, root.familyId)
  }
  if (current.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' }
  }

  return successResult(current, currentRawToken, true)
}

// Revoke every still-live token in a family. Used on reuse detection and logout.
export const revokeFamily = async (prisma: PrismaClient, familyId: string): Promise<void> => {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

// Atomically consume an active refresh token and create its deterministic
// successor. If another request wins the compare-and-swap, recover by replaying
// the same current descendant during the grace window. A predecessor presented
// after the grace window remains theft-signalling reuse and revokes the family.
export const consumeRefreshToken = async (
  prisma: PrismaClient,
  input: ConsumeInput,
): Promise<ConsumeRefreshTokenResult> => {
  const now = input.now ?? new Date()
  const presented = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(input.rawToken) },
    select: refreshTokenSelect,
  }) as RefreshTokenRecord | null

  if (!presented) {
    return { ok: false, reason: 'invalid' }
  }
  if (presented.revokedAt || presented.replacedById) {
    return resolveReplayDescendant(prisma, presented, input.rawToken, input.authSecret, now)
  }
  if (presented.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' }
  }

  const successorId = randomUUID()
  const successorRawToken = deriveRefreshTokenSuccessor(input.rawToken, input.authSecret)
  const successorExpiresAt = new Date(now.getTime() + input.ttlSeconds * 1000)
  const consumed = await prisma.$transaction(async (tx) => {
    const claimed = await tx.refreshToken.updateMany({
      where: { id: presented.id, revokedAt: null, replacedById: null },
      data: { revokedAt: now, replacedById: successorId },
    })
    if (claimed.count !== 1) {
      return false
    }
    await tx.refreshToken.create({
      data: {
        id: successorId,
        userId: presented.userId,
        sessionId: presented.sessionId,
        providerId: presented.providerId,
        providerType: presented.providerType,
        familyId: presented.familyId,
        tokenHash: hashRefreshToken(successorRawToken),
        expiresAt: successorExpiresAt,
        userAgent: input.userAgent ?? undefined,
      },
    })
    return true
  })

  if (!consumed) {
    const concurrent = await prisma.refreshToken.findUnique({
      where: { tokenHash: presented.tokenHash },
      select: refreshTokenSelect,
    }) as RefreshTokenRecord | null
    if (!concurrent) {
      return { ok: false, reason: 'invalid' }
    }
    return resolveReplayDescendant(prisma, concurrent, input.rawToken, input.authSecret, now)
  }

  return successResult(
    {
      ...presented,
      id: successorId,
      tokenHash: hashRefreshToken(successorRawToken),
      revokedAt: null,
      replacedById: null,
      expiresAt: successorExpiresAt,
    },
    successorRawToken,
    false,
  )
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

// Active sessions for a user: one entry per `sessionId` (stable across the
// login's rotation chain). A session is active if any token in its chain is
// still live (non-revoked, unexpired). `createdAt` is the login time (first
// token in the chain), `lastUsedAt` the most recent rotation. Revoked
// predecessors are scanned so the timestamps reflect the whole login, not just
// the latest rotated token.
type SessionAccumulator = UserSession & { active: boolean }

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
    // Tokens are ascending, so this one is later in the chain.
    existing.lastUsedAt = token.createdAt
    existing.expiresAt = token.expiresAt
    if (token.userAgent) {
      existing.userAgent = token.userAgent
    }
    if (live) {
      existing.active = true
    }
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
