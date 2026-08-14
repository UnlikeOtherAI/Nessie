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
  deleteExactUoaWorkspaceSwitchIntent,
  identityMatches,
  identityMatchesTarget,
  loadUoaWorkspaceSwitchIntent,
  targetFromIntent,
  UoaWorkspaceSwitchError,
  type UoaWorkspaceSwitchIntentRecord,
} from './uoa-workspace-switch-intent.js'
import {
  lockRefreshFamily,
  refreshTokenSelect,
  type RefreshTokenRecord,
} from './refresh-token-family.js'
import { AUTH_LOCK_TRANSACTION_OPTIONS } from './user-session-lock.js'
import type { UoaWorkspaceDirectoryEntry } from './uoa-workspace-directory.js'

export type UoaRotationCallbacks = {
  advanceUoaSessionBinding?: (input: {
    nextIdentity: UoaSessionIdentity
    previousIdentity: UoaSessionIdentity
    userId: string
    workspaceDirectory?: UoaWorkspaceDirectoryEntry[]
  }, transaction: Prisma.TransactionClient) => Promise<void>
  rescopeUoaSessionBinding?: (input: {
    nextIdentity: UoaSessionIdentity
    previousIdentity: UoaSessionIdentity
    userId: string
    workspaceDirectory?: UoaWorkspaceDirectoryEntry[]
  }, transaction: Prisma.TransactionClient) => Promise<void>
}

const sameSwitchIntent = (
  left: UoaWorkspaceSwitchIntentRecord,
  right: UoaWorkspaceSwitchIntentRecord,
): boolean =>
  left.familyId === right.familyId
  && left.sourceGeneration === right.sourceGeneration
  && left.sourceLocalTokenId === right.sourceLocalTokenId
  && left.sourceUpstreamTokenHash === right.sourceUpstreamTokenHash
  && left.targetOrganizationId === right.targetOrganizationId
  && left.targetTeamId === right.targetTeamId

export const assertWorkspaceSwitchSource = (
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
    // reconcile the caller to the winning workspace.
    throw new UoaWorkspaceSwitchError(
      'WORKSPACE_SWITCH_CONFLICT',
      'The UnlikeOtherAI access token and refresh cookie do not identify the same source session.',
      false,
    )
  }
}

export const revalidateWorkspaceSwitchIntent = async (
  prisma: PrismaClient,
  input: {
    intent: UoaWorkspaceSwitchIntentRecord
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
      throw new UoaWorkspaceSwitchError(
        'WORKSPACE_SWITCH_CONFLICT',
        'The source session rotated while the workspace switch was starting.',
        false,
      )
    }
    const credential = await loadBoundUoaCredential(transaction, presented)
    const current = await loadUoaWorkspaceSwitchIntent(transaction, {
      credential,
      presented,
    })
    if (!current || !sameSwitchIntent(current, input.intent)) {
      throw new UoaWorkspaceSwitchError(
        'WORKSPACE_SWITCH_CONFLICT',
        'The pending workspace switch changed before the upstream request.',
        false,
      )
    }
  }, AUTH_LOCK_TRANSACTION_OPTIONS)
}

export const clearRefusedWorkspaceSwitchIntent = async (
  prisma: PrismaClient,
  input: {
    intent: UoaWorkspaceSwitchIntentRecord
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
    const current = await loadUoaWorkspaceSwitchIntent(transaction, {
      credential,
      presented,
    })
    if (current && sameSwitchIntent(current, input.intent)) {
      await deleteExactUoaWorkspaceSwitchIntent(transaction, current)
    }
  }, AUTH_LOCK_TRANSACTION_OPTIONS)
}

export const commitUoaRotation = async (
  transaction: Prisma.TransactionClient,
  callbacks: UoaRotationCallbacks,
  presented: RefreshTokenRecord,
  rotated: RotatedUoaCredential,
  lastLocalTokenId: string,
  switchIntent: UoaWorkspaceSwitchIntentRecord | null,
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
  const currentIntent = await loadUoaWorkspaceSwitchIntent(transaction, {
    credential: current,
    presented,
  })
  if (switchIntent) {
    if (
      !currentIntent
      || !sameSwitchIntent(currentIntent, switchIntent)
      || !identityMatchesTarget(rotated.identity, targetFromIntent(switchIntent))
    ) {
      throw new UoaRefreshBindingError(
        'The pending UnlikeOtherAI workspace switch changed during rotation.',
      )
    }
    if (!callbacks.rescopeUoaSessionBinding) {
      throw new UoaRefreshBindingError(
        'UnlikeOtherAI workspace rescoping is not configured.',
      )
    }
    await callbacks.rescopeUoaSessionBinding({
      nextIdentity: rotated.identity,
      previousIdentity: identityFromCredential(rotated.credential),
      userId: presented.userId,
      workspaceDirectory: rotated.workspaceDirectory,
    }, transaction)
  } else {
    if (!callbacks.advanceUoaSessionBinding) {
      throw new UoaRefreshBindingError(
        'UnlikeOtherAI session binding is not configured.',
      )
    }
    await callbacks.advanceUoaSessionBinding({
      nextIdentity: rotated.identity,
      previousIdentity: identityFromCredential(rotated.credential),
      userId: presented.userId,
      workspaceDirectory: rotated.workspaceDirectory,
    }, transaction)
  }
  await persistUoaRotation(transaction, { lastLocalTokenId, rotated })
  if (currentIntent) {
    await deleteExactUoaWorkspaceSwitchIntent(transaction, currentIntent)
  }
}
