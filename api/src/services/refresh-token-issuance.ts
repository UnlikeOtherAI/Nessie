import { randomBytes, randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@prisma/client'
import { deriveSecretKey, encryptWithKey } from '@nessie/runtime'
import type { SessionClientType, UoaSessionIdentity } from '@nessie/schemas'
import { hashRefreshToken } from './refresh-token-crypto.js'
import {
  AUTH_LOCK_TRANSACTION_OPTIONS,
  lockUserSessions,
} from './user-session-lock.js'

type IssueInput = {
  userId: string
  organizationId: string
  sessionId: string
  providerId: string
  providerType: string
  ttlSeconds: number
  encryptionSecret?: string
  uoaSession?: {
    configUrl: string
    identity: UoaSessionIdentity
    refreshToken: string
    refreshTokenExpiresAt: Date
  }
  familyId?: string
  userAgent?: string | null
  clientType?: SessionClientType | null
  expectedPasswordHash?: string
}

export class RefreshTokenIssuanceError extends Error {
  constructor() {
    super('The authenticated user state changed before session issuance.')
    this.name = 'RefreshTokenIssuanceError'
  }
}

/** Issue one hash-only local token and, for UOA, its encrypted family proof. */
export const issueRefreshToken = async (
  prisma: PrismaClient,
  input: IssueInput,
): Promise<{ expiresAt: Date; rawToken: string }> => {
  if (
    (input.providerType === 'uoa' && (!input.uoaSession || !input.encryptionSecret))
    || (input.providerType !== 'uoa' && input.uoaSession)
    || input.uoaSession?.identity.tokenVersion === null
  ) {
    throw new Error('Refresh-token UOA session does not match its provider.')
  }
  const rawToken = randomBytes(32).toString('base64url')
  const familyId = input.familyId ?? randomUUID()
  const localTokenId = randomUUID()
  const createLocalToken = (
    tx: Pick<Prisma.TransactionClient, 'refreshToken'>,
    expiresAt: Date,
  ) => tx.refreshToken.create({
    data: {
      id: localTokenId,
      userId: input.userId,
      sessionId: input.sessionId,
      providerId: input.providerId,
      providerType: input.providerType,
      familyId,
      tokenHash: hashRefreshToken(rawToken),
      expiresAt,
      userAgent: input.userAgent ?? undefined,
      clientType: input.clientType ?? undefined,
    },
  })
  const encrypted = input.uoaSession
    ? encryptWithKey(
        deriveSecretKey(input.encryptionSecret!),
        input.uoaSession.refreshToken,
      )
    : null
  const expiresAt = await prisma.$transaction(async (tx) => {
    await lockUserSessions(tx, input.userId)
    const activeUser = await tx.user.findFirst({
      where: {
        id: input.userId,
        organizationMembers: {
          some: {
            deactivatedAt: null,
            organizationId: input.organizationId,
          },
        },
      },
      select: { passwordHash: true },
    })
    if (
      !activeUser
      || (
        input.expectedPasswordHash !== undefined
        && activeUser.passwordHash !== input.expectedPasswordHash
      )
    ) {
      throw new RefreshTokenIssuanceError()
    }

    const lockedExpiresAt = new Date(Date.now() + input.ttlSeconds * 1000)
    await createLocalToken(tx, lockedExpiresAt)
    if (input.uoaSession && encrypted) {
      await tx.uoaSessionCredential.create({
        data: {
          familyId,
          userId: input.userId,
          providerId: input.providerId,
          subject: input.uoaSession.identity.subject,
          organizationId: input.uoaSession.identity.organizationId,
          teamId: input.uoaSession.identity.teamId,
          tokenVersion: input.uoaSession.identity.tokenVersion!,
          configUrl: input.uoaSession.configUrl,
          refreshTokenHash: hashRefreshToken(input.uoaSession.refreshToken),
          refreshTokenCiphertext: encrypted.ciphertext,
          refreshTokenIv: encrypted.iv,
          refreshTokenAuthTag: encrypted.authTag,
          refreshTokenExpiresAt: input.uoaSession.refreshTokenExpiresAt,
          lastLocalTokenId: localTokenId,
        },
      })
    }
    return lockedExpiresAt
  }, AUTH_LOCK_TRANSACTION_OPTIONS)
  return { rawToken, expiresAt }
}
