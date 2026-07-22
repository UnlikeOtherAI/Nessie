import { randomUUID } from 'node:crypto'

import { type Prisma, type PrismaClient } from '@prisma/client'
import {
  decryptWithKey,
  deriveSecretKey,
  encryptWithKey,
} from '@nessie/runtime'
import {
  UoaSessionIdentitySchema,
  type UoaSessionIdentity,
} from '@nessie/schemas'
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
import { AUTH_LOCK_TRANSACTION_OPTIONS } from './user-session-lock.js'

export { hashRefreshToken } from './refresh-token-crypto.js'
export {
  issueRefreshToken,
  RefreshTokenIssuanceError,
} from './refresh-token-issuance.js'

export { REFRESH_TOKEN_REPLAY_GRACE_MS } from './refresh-token-family.js'

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
  }, transaction: Prisma.TransactionClient) => Promise<{
    identity: UoaSessionIdentity
    refreshToken: string
    refreshTokenExpiresAt: Date
  }>
  userAgent?: string | null
  now?: Date
  clock?: () => Date
}

type UoaCredentialRecord = {
  familyId: string
  userId: string
  providerId: string
  subject: string
  organizationId: string
  teamId: string
  tokenVersion: number
  configUrl: string
  refreshTokenHash: string
  refreshTokenCiphertext: string
  refreshTokenIv: string
  refreshTokenAuthTag: string
  refreshTokenExpiresAt: Date
  lastLocalTokenId: string
  generation: number
}

export class UoaRefreshBindingError extends Error {
  readonly definitive = true

  constructor(message: string) {
    super(message)
    this.name = 'UoaRefreshBindingError'
  }
}

type RefreshCredentialStore = Pick<
  Prisma.TransactionClient,
  'uoaSessionCredential'
>

const uoaCredentialSelect = {
  familyId: true,
  userId: true,
  providerId: true,
  subject: true,
  organizationId: true,
  teamId: true,
  tokenVersion: true,
  configUrl: true,
  refreshTokenHash: true,
  refreshTokenCiphertext: true,
  refreshTokenIv: true,
  refreshTokenAuthTag: true,
  refreshTokenExpiresAt: true,
  lastLocalTokenId: true,
  generation: true,
} as const

const identityFromCredential = (
  credential: UoaCredentialRecord,
): UoaSessionIdentity => {
  const parsed = UoaSessionIdentitySchema.safeParse({
    organizationId: credential.organizationId,
    subject: credential.subject,
    teamId: credential.teamId,
    tokenVersion: credential.tokenVersion,
  })
  if (!parsed.success) {
    throw new UoaRefreshBindingError(
      'The stored UnlikeOtherAI session proof is invalid.',
    )
  }
  return parsed.data
}

const loadBoundUoaCredential = async (
  prisma: RefreshCredentialStore,
  record: RefreshTokenRecord,
): Promise<UoaCredentialRecord> => {
  const credential = await prisma.uoaSessionCredential.findUnique({
    where: { familyId: record.familyId },
    select: uoaCredentialSelect,
  }) as UoaCredentialRecord | null
  if (
    !credential
    || credential.userId !== record.userId
    || credential.providerId !== record.providerId
    || credential.lastLocalTokenId !== record.id
  ) {
    throw new UoaRefreshBindingError(
      'This legacy UnlikeOtherAI session must sign in again.',
    )
  }
  identityFromCredential(credential)
  return credential
}

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

// Revoke every still-live token in a family. Used on reuse detection and logout.
export const revokeFamily = async (prisma: PrismaClient, familyId: string): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    await lockRefreshFamily(tx, familyId)
    await revokeRefreshFamilyRows(tx, familyId, new Date())
  }, AUTH_LOCK_TRANSACTION_OPTIONS)
}

// Atomically consume an active refresh token and create its deterministic
// successor. If another request wins the compare-and-swap, recover by replaying
// the same current descendant during the grace window. A predecessor presented
// after the grace window remains theft-signalling reuse and revokes the family.
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
  return prisma.$transaction(async (tx) => {
    await lockRefreshFamily(tx, familyHint.familyId)
    const presented = await tx.refreshToken.findUnique({
      where: { tokenHash },
      select: refreshTokenSelect,
    }) as RefreshTokenRecord | null
    if (!presented || presented.familyId !== familyHint.familyId) {
      return { ok: false, reason: 'invalid' }
    }

    const requestTime = readClock()
    if (presented.revokedAt || presented.replacedById) {
      const replay = await resolveReplayDescendant(tx, {
        authSecret: input.authSecret,
        now: requestTime,
        root: presented,
        rootRawToken: input.rawToken,
      })
      return replay.ok
        ? successResult(tx, replay.record, replay.rawToken, true)
        : replay
    }
    if (presented.expiresAt.getTime() <= requestTime.getTime()) {
      await revokeRefreshFamilyRows(tx, presented.familyId, requestTime)
      return { ok: false, reason: 'expired' }
    }
    if (
      presented.replayProtectedUntil
      && presented.replayProtectedUntil.getTime() > requestTime.getTime()
    ) {
      return successResult(tx, presented, input.rawToken, true)
    }

    let rotatedUoa: {
      credential: UoaCredentialRecord
      encrypted: ReturnType<typeof encryptWithKey>
      identity: UoaSessionIdentity
      refreshTokenExpiresAt: Date
      refreshTokenHash: string
    } | null = null
    if (presented.providerType === 'uoa') {
      if (!input.refreshUoaSession) {
        throw new UoaRefreshBindingError(
          'UnlikeOtherAI refresh is not configured for this session.',
        )
      }
      const credential = await loadBoundUoaCredential(tx, presented)
      if (credential.refreshTokenExpiresAt.getTime() <= requestTime.getTime()) {
        throw new UoaRefreshBindingError(
          'This UnlikeOtherAI session has expired. Sign in again.',
        )
      }
      const key = deriveSecretKey(input.authSecret)
      let upstreamRefreshToken: string
      try {
        upstreamRefreshToken = decryptWithKey(key, {
          authTag: credential.refreshTokenAuthTag,
          ciphertext: credential.refreshTokenCiphertext,
          iv: credential.refreshTokenIv,
        })
      } catch {
        throw new UoaRefreshBindingError(
          'The stored UnlikeOtherAI session credential is invalid.',
        )
      }
      if (hashRefreshToken(upstreamRefreshToken) !== credential.refreshTokenHash) {
        throw new UoaRefreshBindingError(
          'The stored UnlikeOtherAI session credential is invalid.',
        )
      }
      const expectedIdentity = identityFromCredential(credential)
      const refreshed = await input.refreshUoaSession({
        configUrl: credential.configUrl,
        expectedIdentity,
        refreshToken: upstreamRefreshToken,
        userId: presented.userId,
      }, tx)
      const commitTime = readClock()
      const parsedIdentity = UoaSessionIdentitySchema.safeParse(refreshed.identity)
      if (
        !parsedIdentity.success
        || parsedIdentity.data.tokenVersion === null
        || parsedIdentity.data.subject !== expectedIdentity.subject
        || parsedIdentity.data.organizationId !== expectedIdentity.organizationId
        || parsedIdentity.data.teamId !== expectedIdentity.teamId
        || expectedIdentity.tokenVersion === null
        || parsedIdentity.data.tokenVersion < expectedIdentity.tokenVersion
        || refreshed.refreshTokenExpiresAt.getTime() <= commitTime.getTime()
      ) {
        throw new UoaRefreshBindingError(
          'UnlikeOtherAI returned a different session identity.',
        )
      }
      const nextRefreshTokenHash = hashRefreshToken(refreshed.refreshToken)
      if (nextRefreshTokenHash === credential.refreshTokenHash) {
        throw new UoaRefreshBindingError(
          'UnlikeOtherAI did not rotate the session credential.',
        )
      }
      rotatedUoa = {
        credential,
        encrypted: encryptWithKey(key, refreshed.refreshToken),
        identity: parsedIdentity.data,
        refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
        refreshTokenHash: nextRefreshTokenHash,
      }
    }

    // The decision clock is intentionally read after the upstream round trip.
    // A slow successful UOA refresh must not consume the local response-loss
    // grace period before its deterministic successor is committed.
    const commitTime = readClock()
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
      const updated = await tx.uoaSessionCredential.updateMany({
        where: {
          familyId: presented.familyId,
          generation: rotatedUoa.credential.generation,
          lastLocalTokenId: presented.id,
          refreshTokenHash: rotatedUoa.credential.refreshTokenHash,
        },
        data: {
          subject: rotatedUoa.identity.subject,
          organizationId: rotatedUoa.identity.organizationId,
          teamId: rotatedUoa.identity.teamId,
          tokenVersion: rotatedUoa.identity.tokenVersion!,
          refreshTokenHash: rotatedUoa.refreshTokenHash,
          refreshTokenCiphertext: rotatedUoa.encrypted.ciphertext,
          refreshTokenIv: rotatedUoa.encrypted.iv,
          refreshTokenAuthTag: rotatedUoa.encrypted.authTag,
          refreshTokenExpiresAt: rotatedUoa.refreshTokenExpiresAt,
          lastLocalTokenId: successorId,
          generation: { increment: 1 },
        },
      })
      if (updated.count !== 1) {
        throw new UoaRefreshBindingError(
          'UnlikeOtherAI session rotation conflicted with another request.',
        )
      }
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
