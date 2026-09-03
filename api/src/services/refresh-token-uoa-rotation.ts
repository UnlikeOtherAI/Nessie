import type { Prisma, PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'

import {
  identityFromCredential,
  loadBoundUoaCredential,
  persistUoaRotation,
  UoaRefreshBindingError,
  uoaRotationAlreadyPersisted,
  type RotatedUoaCredential,
} from './refresh-token-uoa.js'
import {
  deleteExactUoaTeamSwitchIntent,
  identityMatches,
  identityMatchesTarget,
  loadUoaTeamSwitchIntent,
  targetFromIntent,
  UoaTeamSwitchError,
  type UoaTeamSwitchIntentRecord,
} from './uoa-team-switch-intent.js'
import {
  lockRefreshFamily,
  refreshTokenSelect,
  type RefreshTokenRecord,
} from './refresh-token-family.js'
import type { ExternalAuthTeam } from './identity-display.js'
import type { ConsumeRefreshTokenResult } from './refresh-token-result.js'
import { AUTH_LOCK_TRANSACTION_OPTIONS } from './user-session-lock.js'
import type { UoaTeamDirectory } from './uoa-team-directory.js'

export type UoaRotationCallbacks = {
  advanceUoaSessionBinding?: (input: {
    nextIdentity: UoaSessionIdentity
    previousIdentity: UoaSessionIdentity
    userId: string
    team?: ExternalAuthTeam
    teamDirectory?: UoaTeamDirectory
  }, transaction: Prisma.TransactionClient) => Promise<void>
  afterUoaSessionBinding?: (input: {
    nextIdentity: UoaSessionIdentity
    userId: string
    teamDirectory?: UoaTeamDirectory
  }) => Promise<void>
}

const sameSwitchIntent = (
  left: UoaTeamSwitchIntentRecord,
  right: UoaTeamSwitchIntentRecord,
): boolean =>
  left.familyId === right.familyId
  && left.sourceGeneration === right.sourceGeneration
  && left.sourceLocalTokenId === right.sourceLocalTokenId
  && left.sourceUpstreamTokenHash === right.sourceUpstreamTokenHash
  && left.targetOrganizationId === right.targetOrganizationId
  && left.targetTeamId === right.targetTeamId

export const assertTeamSwitchSource = (
  input: {
    sourceIdentity: UoaSessionIdentity
    sourceProviderId: string
    sourceSessionId: string
    sourceUserId: string
  },
  presented: RefreshTokenRecord,
  credentialIdentity: UoaSessionIdentity,
): void => {
  if (
    presented.userId !== input.sourceUserId
    || presented.providerId !== input.sourceProviderId
    || presented.providerType !== 'uoa'
    || presented.sessionId !== input.sourceSessionId
    || !identityMatches(credentialIdentity, input.sourceIdentity)
  ) {
    // The credential was already proven to be internally coupled to this
    // refresh family by loadBoundUoaCredential. A mismatch here is therefore
    // stale or unrelated request state (for example, another tab committed a
    // switch and rotated the shared cookie), not evidence that the healthy
    // cookie family is corrupt. Preserve it so an ordinary refresh can
    // reconcile the caller to the winning team.
    throw new UoaTeamSwitchError(
      'TEAM_SWITCH_CONFLICT',
      'The UnlikeOtherAI access token and refresh cookie do not identify the same source session.',
      false,
    )
  }
}

export const revalidateTeamSwitchIntent = async (
  prisma: PrismaClient,
  input: {
    intent: UoaTeamSwitchIntentRecord
    presented: RefreshTokenRecord
  },
): Promise<void> => {
  await prisma.$transaction(async (transaction) => {
    await lockRefreshFamily(transaction, input.presented.familyId)
    const presented = await transaction.refreshToken.findUnique({
      where: { id: input.presented.id },
      select: refreshTokenSelect,
    }) as RefreshTokenRecord | null
    if (
      !presented
      || presented.familyId !== input.presented.familyId
      || presented.tokenHash !== input.presented.tokenHash
      || presented.revokedAt
      || presented.replacedById
    ) {
      throw new UoaTeamSwitchError(
        'TEAM_SWITCH_CONFLICT',
        'The source session rotated while the team switch was starting.',
        false,
      )
    }
    const credential = await loadBoundUoaCredential(transaction, presented)
    const current = await loadUoaTeamSwitchIntent(transaction, {
      credential,
      presented,
    })
    if (!current || !sameSwitchIntent(current, input.intent)) {
      throw new UoaTeamSwitchError(
        'TEAM_SWITCH_CONFLICT',
        'The pending team switch changed before the upstream request.',
        false,
      )
    }
  }, AUTH_LOCK_TRANSACTION_OPTIONS)
}

export const clearRefusedTeamSwitchIntent = async (
  prisma: PrismaClient,
  input: {
    intent: UoaTeamSwitchIntentRecord
    presented: RefreshTokenRecord
  },
): Promise<void> => {
  await prisma.$transaction(async (transaction) => {
    await lockRefreshFamily(transaction, input.presented.familyId)
    const presented = await transaction.refreshToken.findUnique({
      where: { id: input.presented.id },
      select: refreshTokenSelect,
    }) as RefreshTokenRecord | null
    if (!presented || presented.revokedAt || presented.replacedById) return
    const credential = await loadBoundUoaCredential(transaction, presented)
    const current = await loadUoaTeamSwitchIntent(transaction, {
      credential,
      presented,
    })
    if (current && sameSwitchIntent(current, input.intent)) {
      await deleteExactUoaTeamSwitchIntent(transaction, current)
    }
  }, AUTH_LOCK_TRANSACTION_OPTIONS)
}

export const commitUoaRotation = async (
  transaction: Prisma.TransactionClient,
  callbacks: UoaRotationCallbacks,
  presented: RefreshTokenRecord,
  rotated: RotatedUoaCredential,
  lastLocalTokenId: string,
  switchIntent: UoaTeamSwitchIntentRecord | null,
): Promise<void> => {
  const current = await loadBoundUoaCredential(transaction, presented)
  if (uoaRotationAlreadyPersisted(current, rotated, lastLocalTokenId)) return
  if (
    current.generation !== rotated.credential.generation
    || current.refreshTokenHash !== rotated.credential.refreshTokenHash
  ) {
    throw new UoaRefreshBindingError(
      'UnlikeOtherAI session rotation conflicted with another request.',
    )
  }
  const currentIntent = await loadUoaTeamSwitchIntent(transaction, {
    credential: current,
    presented,
  })
  // A pending switch keeps its own exactness check: that request named a
  // team, so the rotation may only commit the team it asked for.
  // Beyond that the binding advance is one path — it adopts whatever team
  // UOA proved, for a switch and for an ordinary refresh alike.
  if (switchIntent) {
    if (
      !currentIntent
      || !sameSwitchIntent(currentIntent, switchIntent)
      || !identityMatchesTarget(rotated.identity, targetFromIntent(switchIntent))
    ) {
      throw new UoaRefreshBindingError(
        'The pending UnlikeOtherAI team switch changed during rotation.',
      )
    }
  }
  if (!callbacks.advanceUoaSessionBinding) {
    throw new UoaRefreshBindingError(
      'UnlikeOtherAI session binding is not configured.',
    )
  }
  await callbacks.advanceUoaSessionBinding({
    nextIdentity: rotated.identity,
    previousIdentity: identityFromCredential(rotated.credential),
    userId: presented.userId,
    team: rotated.team,
    teamDirectory: rotated.teamDirectory,
  }, transaction)
  await persistUoaRotation(transaction, { lastLocalTokenId, rotated })
  if (currentIntent) {
    await deleteExactUoaTeamSwitchIntent(transaction, currentIntent)
  }
}

export const notifyUoaSessionBindingAfterCommit = async (
  callbacks: UoaRotationCallbacks,
  rotated: RotatedUoaCredential | null,
  result: ConsumeRefreshTokenResult,
  userId: string,
): Promise<void> => {
  if (!rotated?.teamDirectory || !result.ok || !callbacks.afterUoaSessionBinding) return
  try {
    await callbacks.afterUoaSessionBinding({
      nextIdentity: rotated.identity,
      userId,
      teamDirectory: rotated.teamDirectory,
    })
  } catch (error) {
    // The credential rotation is already committed. Display-alert
    // reconciliation can retry on the next verified directory read and must
    // never turn a successful rotation into an auth failure.
    console.warn('[uoa] team invitation alert sync failed after rotation', error)
  }
}
