import type { Prisma } from '@prisma/client'
import {
  decryptWithKey,
  deriveSecretKey,
  encryptWithKey,
} from '@nessie/runtime'
import {
  UoaSessionIdentitySchema,
  type UoaSessionIdentity,
} from '@nessie/schemas'

import type { ExternalAuthTeam } from './identity-display.js'
import { hashRefreshToken } from './refresh-token-crypto.js'
import type { RefreshTokenRecord } from './refresh-token-family.js'
import type { UoaTeamDirectory } from './uoa-team-directory.js'

export type UoaCredentialRecord = {
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

export type RotatedUoaCredential = {
  credential: UoaCredentialRecord
  encrypted: ReturnType<typeof encryptWithKey>
  identity: UoaSessionIdentity
  refreshTokenExpiresAt: Date
  refreshTokenHash: string
  // The refreshed token's verified `org` claim, carried through to the local
  // role projection in `uoa-session-context.ts`.
  team?: ExternalAuthTeam
  teamDirectory?: UoaTeamDirectory
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

export const identityFromCredential = (
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

export const loadBoundUoaCredential = async (
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

export const prepareUoaRefresh = async (
  prisma: RefreshCredentialStore,
  input: {
    authSecret: string
    now: Date
    presented: RefreshTokenRecord
  },
): Promise<{
  credential: UoaCredentialRecord
  expectedIdentity: UoaSessionIdentity
  refreshToken: string
}> => {
  const credential = await loadBoundUoaCredential(prisma, input.presented)
  if (credential.refreshTokenExpiresAt.getTime() <= input.now.getTime()) {
    throw new UoaRefreshBindingError(
      'This UnlikeOtherAI session has expired. Sign in again.',
    )
  }
  let refreshToken: string
  try {
    refreshToken = decryptWithKey(deriveSecretKey(input.authSecret), {
      authTag: credential.refreshTokenAuthTag,
      ciphertext: credential.refreshTokenCiphertext,
      iv: credential.refreshTokenIv,
    })
  } catch {
    throw new UoaRefreshBindingError(
      'The stored UnlikeOtherAI session credential is invalid.',
    )
  }
  if (hashRefreshToken(refreshToken) !== credential.refreshTokenHash) {
    throw new UoaRefreshBindingError(
      'The stored UnlikeOtherAI session credential is invalid.',
    )
  }
  return {
    credential,
    expectedIdentity: identityFromCredential(credential),
    refreshToken,
  }
}

export const validateUoaRefresh = (input: {
  authSecret: string
  credential: UoaCredentialRecord
  expectedIdentity: UoaSessionIdentity
  identity: UoaSessionIdentity
  now: Date
  refreshToken: string
  refreshTokenExpiresAt: Date
  targetIdentity?: Pick<UoaSessionIdentity, 'organizationId' | 'teamId'>
  team?: ExternalAuthTeam
  teamDirectory?: UoaTeamDirectory
}): RotatedUoaCredential => {
  const parsedIdentity = UoaSessionIdentitySchema.safeParse(input.identity)
  // Same subject, non-regressing epoch: strictly enforced, because those two
  // checks are what prove this credential still belongs to the same person.
  // A drifted team on an ordinary refresh is adopted rather than refused
  // (see `refreshUoaSession`); `targetIdentity` is present only for an explicit
  // team switch, where the requested tuple must match exactly.
  const expectedTeam = input.targetIdentity
  if (
    !parsedIdentity.success
    || parsedIdentity.data.tokenVersion === null
    || parsedIdentity.data.subject !== input.expectedIdentity.subject
    || (
      expectedTeam
      && (
        parsedIdentity.data.organizationId !== expectedTeam.organizationId
        || parsedIdentity.data.teamId !== expectedTeam.teamId
      )
    )
    || input.expectedIdentity.tokenVersion === null
    || parsedIdentity.data.tokenVersion < input.expectedIdentity.tokenVersion
    || input.refreshTokenExpiresAt.getTime() <= input.now.getTime()
  ) {
    throw new UoaRefreshBindingError(
      'UnlikeOtherAI returned a different session identity.',
    )
  }
  const nextRefreshTokenHash = hashRefreshToken(input.refreshToken)
  if (nextRefreshTokenHash === input.credential.refreshTokenHash) {
    throw new UoaRefreshBindingError(
      'UnlikeOtherAI did not rotate the session credential.',
    )
  }
  return {
    credential: input.credential,
    encrypted: encryptWithKey(
      deriveSecretKey(input.authSecret),
      input.refreshToken,
    ),
    identity: parsedIdentity.data,
    refreshTokenExpiresAt: input.refreshTokenExpiresAt,
    refreshTokenHash: nextRefreshTokenHash,
    ...(input.team ? { team: input.team } : {}),
    ...(input.teamDirectory
      ? { teamDirectory: input.teamDirectory }
      : {}),
  }
}

export const uoaRotationAlreadyPersisted = (
  current: UoaCredentialRecord,
  rotated: RotatedUoaCredential,
  lastLocalTokenId: string,
): boolean =>
  current.lastLocalTokenId === lastLocalTokenId
  && current.refreshTokenHash === rotated.refreshTokenHash
  && current.subject === rotated.identity.subject
  && current.organizationId === rotated.identity.organizationId
  && current.teamId === rotated.identity.teamId
  && current.tokenVersion === rotated.identity.tokenVersion

export const persistUoaRotation = async (
  transaction: Prisma.TransactionClient,
  input: {
    lastLocalTokenId: string
    rotated: RotatedUoaCredential
  },
): Promise<void> => {
  const { rotated } = input
  const updated = await transaction.uoaSessionCredential.updateMany({
    where: {
      familyId: rotated.credential.familyId,
      generation: rotated.credential.generation,
      lastLocalTokenId: rotated.credential.lastLocalTokenId,
      refreshTokenHash: rotated.credential.refreshTokenHash,
    },
    data: {
      subject: rotated.identity.subject,
      organizationId: rotated.identity.organizationId,
      teamId: rotated.identity.teamId,
      tokenVersion: rotated.identity.tokenVersion!,
      refreshTokenHash: rotated.refreshTokenHash,
      refreshTokenCiphertext: rotated.encrypted.ciphertext,
      refreshTokenIv: rotated.encrypted.iv,
      refreshTokenAuthTag: rotated.encrypted.authTag,
      refreshTokenExpiresAt: rotated.refreshTokenExpiresAt,
      lastLocalTokenId: input.lastLocalTokenId,
      generation: { increment: 1 },
    },
  })
  if (updated.count !== 1) {
    throw new UoaRefreshBindingError(
      'UnlikeOtherAI session rotation conflicted with another request.',
    )
  }
}
