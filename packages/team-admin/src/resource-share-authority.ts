import type { PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'
import {
  resolveLiveEntitlements,
  type LiveEntitlements,
} from '@nessie/runtime'

import { canModifyProject } from './resource-authority.js'
import {
  resolveProjectAccess,
  type ProjectViewer,
} from './project-structure.js'

export type ResourceAccessAction = 'manage' | 'read' | 'write'

export type ResourceAccessActor = ProjectViewer & {
  uoaIdentity?: UoaSessionIdentity
}

export type ResourceAccessTarget =
  | {
      kind: 'project'
      projectId: string
      sourceOrganizationId: string
    }
  | {
      boardId: string
      kind: 'board'
      projectId: string
      sourceOrganizationId: string
    }

export type ResourceAccessInput = {
  action: ResourceAccessAction
  actor: ResourceAccessActor
  /** Required for every cross-organisation resource request. */
  shareId?: string
  target: ResourceAccessTarget
}

export type NativeResourceAccess = {
  kind: 'native'
  level: 'full' | 'limited'
  operations: readonly ResourceAccessAction[]
  target: ResourceAccessTarget
}

export type SharedBoardPublication = {
  fieldDefinitions: readonly {
    allowedOptionIds: readonly string[]
    fieldDefinitionId: string
  }[]
  iterations: readonly string[]
  resources: readonly string[]
  revision: number
}

export type SharedResourceAccess = {
  actor: {
    credentialEpoch: number
    organizationId: string
    recipientTeamId: string
    userId: string
    verifiedAt: Date
  }
  grant: {
    access: 'read' | 'write'
    effectiveRevision: number
    expiresAt: Date | null
    id: string
    revision: number
  }
  kind: 'shared'
  operations: readonly Exclude<ResourceAccessAction, 'manage'>[]
  publication: SharedBoardPublication | null
  source: {
    boardId: string | null
    organizationId: string
    projectId: string
    teamId: string
  }
  target: ResourceAccessTarget
}

export type ResourceAccessDenialReason =
  | 'grant_denied'
  | 'native_denied'
  | 'share_context_required'
  | 'sharing_disabled'
  | 'target_not_found'

export type ResourceAccessDecision =
  | NativeResourceAccess
  | SharedResourceAccess
  | { kind: 'denied'; reason: ResourceAccessDenialReason }

export type SharingPolicyContext = {
  actorOrganizationId: string
  projectId: string
  recipientTeamId: string
  sourceOrganizationId: string
  sourceTeamId: string
}

export type ResourceShareAuthorityDependencies = {
  canModifyNativeProject?: typeof canModifyProject
  isSharingEnabled?: () => boolean
  isSharingPolicyEligible?: (context: SharingPolicyContext) => Promise<boolean>
  now?: () => Date
  resolveLiveRecipientEntitlements?: (
    prisma: PrismaClient,
    actor: ResourceAccessActor,
  ) => Promise<LiveEntitlements>
  resolveNativeProjectAccess?: typeof resolveProjectAccess
}

const denied = (reason: ResourceAccessDenialReason): ResourceAccessDecision => ({
  kind: 'denied',
  reason,
})

const resolveNativeAccess = async (
  prisma: PrismaClient,
  input: ResourceAccessInput,
  deps: ResourceShareAuthorityDependencies,
): Promise<ResourceAccessDecision> => {
  const resolveRead = deps.resolveNativeProjectAccess ?? resolveProjectAccess
  const resolveWrite = deps.canModifyNativeProject ?? canModifyProject
  if (input.action === 'read') {
    const projectAccess = await resolveRead(prisma, input.actor, input.target.projectId)
    if (projectAccess === 'none') return denied('native_denied')
    if (input.target.kind === 'board' && projectAccess !== 'full') {
      return denied('native_denied')
    }
    const canModify = projectAccess === 'full'
      ? await resolveWrite(prisma, input.actor, input.target.projectId)
      : false
    return {
      kind: 'native',
      level: projectAccess,
      operations: canModify ? ['read', 'write', 'manage'] : ['read'],
      target: input.target,
    }
  }
  if (!(await resolveWrite(prisma, input.actor, input.target.projectId))) {
    return denied('native_denied')
  }
  return {
    kind: 'native',
    level: 'full',
    operations: ['read', 'write', 'manage'],
    target: input.target,
  }
}

const resolveLiveRecipient = async (
  prisma: PrismaClient,
  actor: ResourceAccessActor,
): Promise<LiveEntitlements> => resolveLiveEntitlements(prisma, {
  organizationId: actor.organizationId,
  uoaIdentity: actor.uoaIdentity,
  userId: actor.userId,
})

const actionAllowed = (
  action: ResourceAccessAction,
  access: 'read' | 'write',
): boolean => action === 'read' || (action === 'write' && access === 'write')

/**
 * Resolves one qualified project or board access path without changing the
 * authenticated tenant. Native checks run only when actor and resource tenant
 * are equal. A foreign resource requires an explicit share id, a fresh UOA
 * recipient-team proof, one complete active grant, and an explicit rollout and
 * policy decision. Recipient organisation roles never enter native authority.
 */
export const resolveResourceAccess = async (
  prisma: PrismaClient,
  input: ResourceAccessInput,
  deps: ResourceShareAuthorityDependencies = {},
): Promise<ResourceAccessDecision> => {
  const project = await prisma.project.findUnique({
    where: { id: input.target.projectId },
    select: {
      channelRoot: true,
      deletedAt: true,
      organizationId: true,
      teamId: true,
    },
  })
  if (
    !project ||
    project.deletedAt ||
    project.organizationId !== input.target.sourceOrganizationId
  ) return denied('target_not_found')

  if (input.target.kind === 'board') {
    const board = await prisma.board.findFirst({
      where: {
        id: input.target.boardId,
        organizationId: input.target.sourceOrganizationId,
        projectId: input.target.projectId,
      },
      select: { id: true },
    })
    if (!board) return denied('target_not_found')
  }

  if (input.actor.organizationId === input.target.sourceOrganizationId) {
    return resolveNativeAccess(prisma, input, deps)
  }
  if (!(deps.isSharingEnabled?.() ?? false)) return denied('sharing_disabled')
  if (!input.shareId) return denied('share_context_required')
  if (project.channelRoot || !project.teamId || input.action === 'manage') {
    return denied('grant_denied')
  }

  const resolveLive = deps.resolveLiveRecipientEntitlements ?? resolveLiveRecipient
  const entitlements = await resolveLive(prisma, input.actor)
  if (
    entitlements.kind !== 'uoa' ||
    entitlements.organizationId !== input.actor.organizationId ||
    entitlements.userId !== input.actor.userId ||
    entitlements.teamIds.length === 0
  ) {
    return denied('grant_denied')
  }

  const now = deps.now?.() ?? new Date()
  const share = await prisma.resourceShare.findUnique({
    where: { id: input.shareId },
    select: {
      boardId: true,
      effectiveAccess: true,
      effectiveRevision: true,
      expiresAt: true,
      health: true,
      id: true,
      projectId: true,
      recipientOrganizationId: true,
      recipientTeamId: true,
      revision: true,
      scope: true,
      sourceOrganizationId: true,
      sourceTeamId: true,
      status: true,
      targetBoardId: true,
    },
  })
  if (
    !share ||
    share.status !== 'active' ||
    share.health !== 'healthy' ||
    !share.effectiveAccess ||
    share.effectiveRevision === null ||
    (share.expiresAt !== null && share.expiresAt <= now) ||
    share.sourceOrganizationId !== input.target.sourceOrganizationId ||
    share.projectId !== input.target.projectId ||
    share.sourceTeamId !== project.teamId ||
    share.recipientOrganizationId !== input.actor.organizationId ||
    !entitlements.teamIds.includes(share.recipientTeamId) ||
    !actionAllowed(input.action, share.effectiveAccess)
  ) return denied('grant_denied')

  if (
    (input.target.kind === 'project' && share.scope !== 'project') ||
    (input.target.kind === 'board' &&
      share.scope === 'board' &&
      (share.targetBoardId !== input.target.boardId || share.boardId !== input.target.boardId))
  ) return denied('grant_denied')

  const policyEligible = deps.isSharingPolicyEligible
  if (!policyEligible || !(await policyEligible({
    actorOrganizationId: input.actor.organizationId,
    projectId: input.target.projectId,
    recipientTeamId: share.recipientTeamId,
    sourceOrganizationId: input.target.sourceOrganizationId,
    sourceTeamId: share.sourceTeamId,
  }))) return denied('grant_denied')

  let publication: SharedBoardPublication | null = null
  if (share.scope === 'board') {
    const row = await prisma.boardSharePublication.findUnique({
      where: { boardId: share.targetBoardId ?? '' },
      select: {
        fields: {
          orderBy: { fieldDefinitionId: 'asc' },
          select: { allowedOptionIds: true, fieldDefinitionId: true },
        },
        iterations: {
          orderBy: { iterationId: 'asc' },
          select: { iterationId: true },
        },
        resources: {
          orderBy: { pageId: 'asc' },
          select: { pageId: true },
        },
        revision: true,
      },
    })
    if (!row) return denied('grant_denied')
    publication = {
      fieldDefinitions: row.fields,
      iterations: row.iterations.map(({ iterationId }) => iterationId),
      resources: row.resources.map(({ pageId }) => pageId),
      revision: row.revision,
    }
  }

  const credentialEpoch = input.actor.uoaIdentity?.tokenVersion
  if (credentialEpoch === undefined || credentialEpoch === null) {
    return denied('grant_denied')
  }
  return {
    actor: {
      credentialEpoch,
      organizationId: input.actor.organizationId,
      recipientTeamId: share.recipientTeamId,
      userId: input.actor.userId,
      verifiedAt: now,
    },
    grant: {
      access: share.effectiveAccess,
      effectiveRevision: share.effectiveRevision,
      expiresAt: share.expiresAt,
      id: share.id,
      revision: share.revision,
    },
    kind: 'shared',
    operations: share.effectiveAccess === 'write' ? ['read', 'write'] : ['read'],
    publication,
    source: {
      boardId: input.target.kind === 'board' ? input.target.boardId : null,
      organizationId: input.target.sourceOrganizationId,
      projectId: input.target.projectId,
      teamId: share.sourceTeamId,
    },
    target: input.target,
  }
}
