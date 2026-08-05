import { randomUUID } from 'node:crypto'

import { type Prisma, type PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'
import {
  deriveRefreshTokenSuccessor,
  hashRefreshToken,
} from './refresh-token-crypto.js'
import {
  lockRefreshFamily,
  refreshTokenSelect,
  resolveReplayDescendant,
  revokeRefreshFamilyRows,
  type RefreshTokenRecord,
} from './refresh-token-family.js'
import {
  identityFromCredential,
  loadBoundUoaCredential,
  persistUoaRotation,
  prepareUoaRefresh,
  UoaRefreshBindingError,
  uoaRotationAlreadyPersisted,
  validateUoaRefresh,
  type RotatedUoaCredential,
  type UoaCredentialRecord,
} from './refresh-token-uoa.js'
import { AUTH_LOCK_TRANSACTION_OPTIONS } from './user-session-lock.js'

export { hashRefreshToken } from './refresh-token-crypto.js'
export {
  issueRefreshToken,
  RefreshTokenIssuanceError,
} from './refresh-token-issuance.js'

export { REFRESH_TOKEN_REPLAY_GRACE_MS } from './refresh-token-family.js'
export { UoaRefreshBindingError } from './refresh-token-uoa.js'

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
      uoaIdentity?: UoaSessionIdentity
    }
  | { ok: false; reason: 'expired' | 'invalid' | 'reuse' }

type ConsumeInput = {
  authSecret: string
  rawToken: string
  ttlSeconds: number
  refreshUoaSession?: (input: {
    configUrl: string
    expectedIdentity: UoaSessionIdentity
    refreshToken: string
    userId: string
  }) => Promise<{
    identity: UoaSessionIdentity
    refreshToken: string
    refreshTokenExpiresAt: Date
  }>
  advanceUoaSessionBinding?: (input: {
    nextIdentity: UoaSessionIdentity
    previousIdentity: UoaSessionIdentity
    userId: string
  }, transaction: Prisma.TransactionClient) => Promise<void>
  userAgent?: string | null
  now?: Date
  clock?: () => Date
}

type RefreshPreflight =
  | { kind: 'result'; result: ConsumeRefreshTokenResult }
  | {
      kind: 'rotate'
      presented: RefreshTokenRecord
      uoa: {
        credential: UoaCredentialRecord
        expectedIdentity: UoaSessionIdentity
        refreshToken: string
      } | null
    }

type RefreshCredentialStore = Pick<
  Prisma.TransactionClient,
  'uoaSessionCredential'
>

const successResult = async (
  prisma: RefreshCredentialStore,
  record: RefreshTokenRecord,
  rawToken: string,
  replayed: boolean,
): Promise<ConsumeRefreshTokenResult> => {
  const uoaIdentity = record.providerType === 'uoa'
    ? identityFromCredential(await loadBoundUoaCredential(prisma, record))
    : undefined
  return {
    ok: true,
    expiresAt: record.expiresAt,
    familyId: record.familyId,
    rawToken,
    replayed,
    sessionId: record.sessionId,
    userId: record.userId,
    providerId: record.providerId,
    providerType: record.providerType,
    ...(uoaIdentity ? { uoaIdentity } : {}),
  }
}

const commitUoaRotation = async (
  transaction: Prisma.TransactionClient,
  input: ConsumeInput,
  presented: RefreshTokenRecord,
  rotated: RotatedUoaCredential,
  lastLocalTokenId: string,
): Promise<void> => {
  const current = await loadBoundUoaCredential(transaction, presented)
  if (uoaRotationAlreadyPersisted(current, rotated, lastLocalTokenId)) {
    return
  }
  if (
    current.generation !== rotated.credential.generation
    || current.refreshTokenHash !== rotated.credential.refreshTokenHash
  ) {
    throw new UoaRefreshBindingError(
      'UnlikeOtherAI session rotation conflicted with another request.',
    )
  }
  if (!input.advanceUoaSessionBinding) {
    throw new UoaRefreshBindingError(
      'UnlikeOtherAI session binding is not configured.',
    )
  }
  await input.advanceUoaSessionBinding({
    nextIdentity: rotated.identity,
    previousIdentity: identityFromCredential(rotated.credential),
    userId: presented.userId,
  }, transaction)
  await persistUoaRotation(transaction, { lastLocalTokenId, rotated })
}

// Revoke every still-live token in a family. Used on reuse detection and logout.
export const revokeFamily = async (prisma: PrismaClient, familyId: string): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    await lockRefreshFamily(tx, familyId)
    await revokeRefreshFamilyRows(tx, familyId, new Date())
  }, AUTH_LOCK_TRANSACTION_OPTIONS)
}

// Consume an active refresh token and create its deterministic successor. UOA
// renewal runs between two short family-locked transactions: its refresh-token
// endpoint deterministically replays one exact successor, so concurrent or
// response-loss retries may safely perform the same network call while the
// local compare-and-swap converges on one successor. No external I/O holds a DB
// connection or advisory lock. A predecessor presented after the local grace
// window remains theft-signalling reuse and revokes the family.
export const consumeRefreshToken = async (
  prisma: PrismaClient,
  input: ConsumeInput,
): Promise<ConsumeRefreshTokenResult> => {
  const tokenHash = hashRefreshToken(input.rawToken)
  const familyHint = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    select: { familyId: true },
  })
  if (!familyHint) {
    return { ok: false, reason: 'invalid' }
  }

  const readClock = (): Date => input.clock?.() ?? input.now ?? new Date()
  const preflight: RefreshPreflight = await prisma.$transaction(async (tx) => {
    await lockRefreshFamily(tx, familyHint.familyId)
    const presented = await tx.refreshToken.findUnique({
      where: { tokenHash },
      select: refreshTokenSelect,
    }) as RefreshTokenRecord | null
    if (!presented || presented.familyId !== familyHint.familyId) {
      return {
        kind: 'result',
        result: { ok: false, reason: 'invalid' },
      }
    }

    const requestTime = readClock()
    if (presented.revokedAt || presented.replacedById) {
      const replay = await resolveReplayDescendant(tx, {
        authSecret: input.authSecret,
        now: requestTime,
        root: presented,
        rootRawToken: input.rawToken,
      })
      return {
        kind: 'result',
        result: replay.ok
          ? await successResult(tx, replay.record, replay.rawToken, true)
          : replay,
      }
    }
    if (presented.expiresAt.getTime() <= requestTime.getTime()) {
      await revokeRefreshFamilyRows(tx, presented.familyId, requestTime)
      return { kind: 'result', result: { ok: false, reason: 'expired' } }
    }
    if (
      presented.replayProtectedUntil
      && presented.replayProtectedUntil.getTime() > requestTime.getTime()
    ) {
      return {
        kind: 'result',
        result: await successResult(tx, presented, input.rawToken, true),
      }
    }

    if (presented.providerType !== 'uoa') {
      return { kind: 'rotate', presented, uoa: null }
    }
    if (!input.refreshUoaSession || !input.advanceUoaSessionBinding) {
      throw new UoaRefreshBindingError(
        'UnlikeOtherAI refresh is not configured for this session.',
      )
    }
    return {
      kind: 'rotate',
      presented,
      uoa: await prepareUoaRefresh(tx, {
        authSecret: input.authSecret,
        now: requestTime,
        presented,
      }),
    }
  }, AUTH_LOCK_TRANSACTION_OPTIONS)

  if (preflight.kind === 'result') {
    return preflight.result
  }

  let rotatedUoa: RotatedUoaCredential | null = null
  if (preflight.uoa) {
    const refreshed = await input.refreshUoaSession!({
      configUrl: preflight.uoa.credential.configUrl,
      expectedIdentity: preflight.uoa.expectedIdentity,
      refreshToken: preflight.uoa.refreshToken,
      userId: preflight.presented.userId,
    })
    rotatedUoa = validateUoaRefresh({
      authSecret: input.authSecret,
      credential: preflight.uoa.credential,
      expectedIdentity: preflight.uoa.expectedIdentity,
      identity: refreshed.identity,
      now: readClock(),
      refreshToken: refreshed.refreshToken,
      refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
    })
  }

  return prisma.$transaction(async (tx) => {
    await lockRefreshFamily(tx, familyHint.familyId)
    const presented = await tx.refreshToken.findUnique({
      where: { tokenHash },
      select: refreshTokenSelect,
    }) as RefreshTokenRecord | null
    if (!presented || presented.familyId !== familyHint.familyId) {
      return { ok: false, reason: 'invalid' }
    }

    // The decision clock is intentionally read after the upstream round trip.
    // A slow successful UOA refresh must not consume the local response-loss
    // grace period before its deterministic successor is committed.
    const commitTime = readClock()
    if (presented.revokedAt || presented.replacedById) {
      const replay = await resolveReplayDescendant(tx, {
        authSecret: input.authSecret,
        now: commitTime,
        root: presented,
        rootRawToken: input.rawToken,
      })
      return replay.ok
        ? successResult(tx, replay.record, replay.rawToken, true)
        : replay
    }
    if (presented.expiresAt.getTime() <= commitTime.getTime()) {
      await revokeRefreshFamilyRows(tx, presented.familyId, commitTime)
      return { ok: false, reason: 'expired' }
    }
    if (
      presented.replayProtectedUntil
      && presented.replayProtectedUntil.getTime() > commitTime.getTime()
    ) {
      if (rotatedUoa) {
        // An ancestor replay won while UOA renewal was in flight. Keep the
        // barrier's local cookie, but adopt the exact replay-safe upstream
        // successor in place so the two credential chains cannot diverge.
        await commitUoaRotation(
          tx,
          input,
          presented,
          rotatedUoa,
          presented.id,
        )
      }
      return successResult(tx, presented, input.rawToken, true)
    }

    const successorId = randomUUID()
    const successorRawToken = deriveRefreshTokenSuccessor(
      input.rawToken,
      input.authSecret,
    )
    const successorExpiresAt = new Date(
      commitTime.getTime() + input.ttlSeconds * 1000,
    )
    const claimed = await tx.refreshToken.updateMany({
      where: { id: presented.id, revokedAt: null, replacedById: null },
      data: { revokedAt: commitTime, replacedById: successorId },
    })
    if (claimed.count !== 1) {
      return { ok: false, reason: 'invalid' }
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
    if (rotatedUoa) {
      await commitUoaRotation(tx, input, presented, rotatedUoa, successorId)
    }

    return successResult(
      tx,
      {
        ...presented,
        id: successorId,
        tokenHash: hashRefreshToken(successorRawToken),
        revokedAt: null,
        replacedById: null,
        replayProtectedUntil: null,
        expiresAt: successorExpiresAt,
      },
      successorRawToken,
      false,
    )
  }, AUTH_LOCK_TRANSACTION_OPTIONS)
}

// Logout: revoke the family of the presented token. Missing/unknown tokens are
// a no-op so logout is always idempotent. Returns the owning user id when a
// family was actually revoked, so the caller can also bump that user's
// tokenVersion and kill their outstanding access token.
export const revokeRefreshTokenByRaw = async (
  prisma: PrismaClient,
  rawToken: string,
): Promise<{ userId: string } | null> => {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(rawToken) },
    select: { familyId: true, userId: true },
  })
  if (!record) return null
  await revokeFamily(prisma, record.familyId)
  return { userId: record.userId }
}
