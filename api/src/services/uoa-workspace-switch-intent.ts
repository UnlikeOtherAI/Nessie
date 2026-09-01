import type { Prisma } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'

import type { RefreshTokenRecord } from './refresh-token-family.js'
import {
  identityFromCredential,
  UoaRefreshBindingError,
  type UoaCredentialRecord,
} from './refresh-token-uoa.js'
import type { UoaWorkspaceSwitchTarget } from './uoa-session.js'

export type UoaWorkspaceSwitchIntentRecord = {
  familyId: string
  userId: string
  providerId: string
  subject: string
  sourceOrganizationId: string
  sourceTeamId: string
  sourceTokenVersion: number
  sourceGeneration: number
  sourceLocalTokenId: string
  sourceUpstreamTokenHash: string
  targetOrganizationId: string
  targetTeamId: string
}

type IntentStore = Pick<Prisma.TransactionClient, 'uoaWorkspaceSwitchIntent'>

const intentSelect = {
  familyId: true,
  userId: true,
  providerId: true,
  subject: true,
  sourceOrganizationId: true,
  sourceTeamId: true,
  sourceTokenVersion: true,
  sourceGeneration: true,
  sourceLocalTokenId: true,
  sourceUpstreamTokenHash: true,
  targetOrganizationId: true,
  targetTeamId: true,
} as const

export class UoaWorkspaceSwitchError extends Error {
  constructor(
    public readonly code:
      | 'INTERACTION_REQUIRED'
      | 'WORKSPACE_NOT_AVAILABLE'
      | 'WORKSPACE_SWITCH_CONFLICT',
    message: string,
    public readonly clearIntent: boolean,
  ) {
    super(message)
    this.name = 'UoaWorkspaceSwitchError'
  }
}

export const identityMatches = (
  left: UoaSessionIdentity,
  right: UoaSessionIdentity,
): boolean =>
  left.subject === right.subject
  && left.organizationId === right.organizationId
  && left.teamId === right.teamId
  && left.tokenVersion === right.tokenVersion

export const identityMatchesTarget = (
  identity: UoaSessionIdentity,
  target: UoaWorkspaceSwitchTarget,
): boolean =>
  identity.organizationId === target.organizationId
  && identity.teamId === target.teamId

const targetMatches = (
  intent: UoaWorkspaceSwitchIntentRecord,
  target: UoaWorkspaceSwitchTarget,
): boolean =>
  intent.targetOrganizationId === target.organizationId
  && intent.targetTeamId === target.teamId

export const intentSourceMatches = (
  intent: UoaWorkspaceSwitchIntentRecord,
  credential: UoaCredentialRecord,
  presented: RefreshTokenRecord,
): boolean =>
  intent.familyId === credential.familyId
  && intent.familyId === presented.familyId
  && intent.userId === credential.userId
  && intent.userId === presented.userId
  && intent.providerId === credential.providerId
  && intent.providerId === presented.providerId
  && intent.subject === credential.subject
  && intent.sourceOrganizationId === credential.organizationId
  && intent.sourceTeamId === credential.teamId
  && intent.sourceTokenVersion === credential.tokenVersion
  && intent.sourceGeneration === credential.generation
  && intent.sourceLocalTokenId === credential.lastLocalTokenId
  && intent.sourceLocalTokenId === presented.id
  && intent.sourceUpstreamTokenHash === credential.refreshTokenHash

const requireExactSource = (
  intent: UoaWorkspaceSwitchIntentRecord,
  credential: UoaCredentialRecord,
  presented: RefreshTokenRecord,
): void => {
  if (!intentSourceMatches(intent, credential, presented)) {
    throw new UoaRefreshBindingError(
      'The pending UnlikeOtherAI workspace switch no longer matches its source session.',
    )
  }
}

export const loadUoaWorkspaceSwitchIntent = async (
  transaction: IntentStore,
  input: {
    credential: UoaCredentialRecord
    presented: RefreshTokenRecord
  },
): Promise<UoaWorkspaceSwitchIntentRecord | null> => {
  const intent = await transaction.uoaWorkspaceSwitchIntent.findUnique({
    where: { familyId: input.presented.familyId },
    select: intentSelect,
  }) as UoaWorkspaceSwitchIntentRecord | null
  if (intent) requireExactSource(intent, input.credential, input.presented)
  return intent
}

export const ensureUoaWorkspaceSwitchIntent = async (
  transaction: IntentStore,
  input: {
    credential: UoaCredentialRecord
    presented: RefreshTokenRecord
    target: UoaWorkspaceSwitchTarget
  },
): Promise<UoaWorkspaceSwitchIntentRecord> => {
  const sourceIdentity = identityFromCredential(input.credential)
  if (identityMatchesTarget(sourceIdentity, input.target)) {
    throw new UoaWorkspaceSwitchError(
      'WORKSPACE_SWITCH_CONFLICT',
      'This UnlikeOtherAI session is already scoped to that workspace.',
      false,
    )
  }
  const existing = await transaction.uoaWorkspaceSwitchIntent.findUnique({
    where: { familyId: input.presented.familyId },
    select: intentSelect,
  }) as UoaWorkspaceSwitchIntentRecord | null
  if (existing) {
    requireExactSource(existing, input.credential, input.presented)
    if (!targetMatches(existing, input.target)) {
      throw new UoaWorkspaceSwitchError(
        'WORKSPACE_SWITCH_CONFLICT',
        'Another workspace switch is already in progress for this session.',
        false,
      )
    }
    return existing
  }

  return transaction.uoaWorkspaceSwitchIntent.create({
    data: {
      familyId: input.credential.familyId,
      providerId: input.credential.providerId,
      sourceGeneration: input.credential.generation,
      sourceLocalTokenId: input.credential.lastLocalTokenId,
      sourceOrganizationId: sourceIdentity.organizationId,
      sourceTeamId: sourceIdentity.teamId,
      sourceTokenVersion: sourceIdentity.tokenVersion!,
      sourceUpstreamTokenHash: input.credential.refreshTokenHash,
      subject: sourceIdentity.subject,
      targetOrganizationId: input.target.organizationId,
      targetTeamId: input.target.teamId,
      userId: input.credential.userId,
    },
    select: intentSelect,
  }) as Promise<UoaWorkspaceSwitchIntentRecord>
}

export const deleteExactUoaWorkspaceSwitchIntent = async (
  transaction: IntentStore,
  intent: UoaWorkspaceSwitchIntentRecord,
): Promise<void> => {
  const deleted = await transaction.uoaWorkspaceSwitchIntent.deleteMany({
    where: {
      familyId: intent.familyId,
      sourceGeneration: intent.sourceGeneration,
      sourceLocalTokenId: intent.sourceLocalTokenId,
      sourceUpstreamTokenHash: intent.sourceUpstreamTokenHash,
      targetOrganizationId: intent.targetOrganizationId,
      targetTeamId: intent.targetTeamId,
    },
  })
  if (deleted.count !== 1) {
    throw new UoaRefreshBindingError(
      'The pending UnlikeOtherAI workspace switch changed during commit.',
    )
  }
}

export const targetFromIntent = (
  intent: UoaWorkspaceSwitchIntentRecord,
): UoaWorkspaceSwitchTarget => ({
  organizationId: intent.targetOrganizationId,
  teamId: intent.targetTeamId,
})
