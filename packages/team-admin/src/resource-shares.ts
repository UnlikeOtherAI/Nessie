import { Prisma, type PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  ResourceShareAccess,
  ResourceShareScope,
} from '@nessie/schemas'

import {
  RESOURCE_SHARE_AUDIT_SELECT,
  toResourceShareTransitionResult,
  writeResourceShareLifecycleAudit,
  type ResourceShareAuditActor,
  type ResourceShareTransitionResult,
} from './resource-share-audit.js'

export type { ResourceShareTransitionResult } from './resource-share-audit.js'

export type ResourceShareLifecycleActor = AuthorizedActionContext

export type ResourceShareLifecycleDependencies = {
  authorizeRecipientTeamManager: (
    prisma: PrismaClient,
    input: {
      actor: ResourceShareLifecycleActor
      recipientExternalOrgId: string
      recipientExternalTeamId: string
      recipientOrganizationId: string
      recipientTeamId: string
    },
  ) => Promise<boolean>
  authorizeSourceManager: (
    prisma: PrismaClient,
    input: {
      actor: ResourceShareLifecycleActor
      projectId: string
      sourceOrganizationId: string
      sourceTeamId: string
    },
  ) => Promise<boolean>
  isSharingEnabled?: () => boolean
  isSharingPolicyEligible: (
    prisma: PrismaClient,
    input: {
      projectId: string
      recipientOrganizationId: string
      recipientTeamId: string
      sourceOrganizationId: string
      sourceTeamId: string
    },
  ) => Promise<boolean>
  now?: () => Date
}

export type ResourceShareLifecycleErrorCode =
  | 'conflict'
  | 'denied'
  | 'invalid_target'
  | 'not_found'
  | 'sharing_disabled'

export class ResourceShareLifecycleError extends Error {
  constructor(public readonly code: ResourceShareLifecycleErrorCode) {
    super(code)
    this.name = 'ResourceShareLifecycleError'
  }
}

const deny = (code: ResourceShareLifecycleErrorCode): never => {
  throw new ResourceShareLifecycleError(code)
}

const requireHumanUoaActor = (
  actor: ResourceShareLifecycleActor,
  expectedOrganizationId: string,
  expectedExternalOrgId: string,
): ResourceShareAuditActor => {
  const identity = actor.actionContext.uoaIdentity
  if (
    actor.actor.actorType !== 'user' ||
    !identity ||
    actor.tenant.organizationId !== expectedOrganizationId ||
    identity.organizationId !== expectedExternalOrgId
  ) throw new ResourceShareLifecycleError('denied')
  return {
    actorId: actor.actor.actorId,
    actorOrganizationRef: identity.organizationId,
    actorSubject: identity.subject,
    requestId: actor.actionContext.requestId,
  }
}

const sharingEnabled = (deps: ResourceShareLifecycleDependencies): void => {
  if (!(deps.isSharingEnabled?.() ?? false)) deny('sharing_disabled')
}

const isUniqueConflict = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

type LiveShareTarget = {
  boardId: string | null
  projectId: string
  scope: ResourceShareScope
  sourceExternalOrgId: string
  sourceExternalTeamId: string
  sourceOrganizationId: string
  sourceTeamId: string
}

const lockLiveShareTarget = async (
  tx: Prisma.TransactionClient,
  target: LiveShareTarget,
): Promise<void> => {
  const projects = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT p."id"
    FROM "projects" p
    JOIN "organizations" o ON o."id" = p."organization_id"
    JOIN "teams" t ON t."id" = p."team_id"
    WHERE p."id" = ${target.projectId}::uuid
      AND p."organization_id" = ${target.sourceOrganizationId}::uuid
      AND p."team_id" = ${target.sourceTeamId}::uuid
      AND p."deleted_at" IS NULL
      AND p."channel_root" = false
      AND o."external_org_id" = ${target.sourceExternalOrgId}
      AND t."external_org_id" = ${target.sourceExternalOrgId}
      AND t."external_team_id" = ${target.sourceExternalTeamId}
      AND t."system_managed" = false
    FOR SHARE OF p, o, t
  `)
  if (projects.length !== 1) deny('invalid_target')

  if (target.scope === 'board') {
    if (!target.boardId) deny('invalid_target')
    const boards = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT b."id"
      FROM "boards" b
      JOIN "board_share_publications" publication
        ON publication."board_id" = b."id"
      WHERE b."id" = ${target.boardId}::uuid
        AND b."project_id" = ${target.projectId}::uuid
        AND b."organization_id" = ${target.sourceOrganizationId}::uuid
      FOR SHARE OF b, publication
    `)
    if (boards.length !== 1) deny('invalid_target')
  }
}

export type CreateResourceShareInput = {
  access: ResourceShareAccess
  actor: ResourceShareLifecycleActor
  boardId?: string
  expiresAt?: Date | null
  projectId: string
  recipientOrganizationId: string
  recipientTeamId: string
  scope: ResourceShareScope
}

export const createResourceShare = async (
  prisma: PrismaClient,
  input: CreateResourceShareInput,
  deps: ResourceShareLifecycleDependencies,
): Promise<ResourceShareTransitionResult> => {
  sharingEnabled(deps)
  const now = deps.now?.() ?? new Date()
  if (input.expiresAt && input.expiresAt <= now) deny('invalid_target')
  if ((input.scope === 'board') !== Boolean(input.boardId)) deny('invalid_target')

  const [project, recipientOrganization, recipientTeam] = await Promise.all([
    prisma.project.findUnique({
      where: { id: input.projectId },
      select: {
        channelRoot: true,
        deletedAt: true,
        id: true,
        organization: { select: { externalOrgId: true } },
        organizationId: true,
        team: {
          select: { externalOrgId: true, externalTeamId: true, id: true, systemManaged: true },
        },
      },
    }),
    prisma.organization.findUnique({
      where: { id: input.recipientOrganizationId },
      select: { externalOrgId: true, id: true },
    }),
    prisma.team.findUnique({
      where: { id: input.recipientTeamId },
      select: { externalOrgId: true, externalTeamId: true, id: true, systemManaged: true },
    }),
  ])
  if (
    !project || project.deletedAt || project.channelRoot || !project.team ||
    project.team.systemManaged || !project.organization.externalOrgId ||
    !project.team.externalTeamId ||
    project.team.externalOrgId !== project.organization.externalOrgId ||
    !recipientOrganization?.externalOrgId || !recipientTeam?.externalTeamId ||
    recipientTeam.systemManaged ||
    recipientTeam.externalOrgId !== recipientOrganization.externalOrgId ||
    project.organizationId === recipientOrganization.id
  ) throw new ResourceShareLifecycleError('invalid_target')

  const sourceExternalOrgId = project.organization.externalOrgId
  const sourceExternalTeamId = project.team.externalTeamId
  const sourceTeamId = project.team.id
  const recipientExternalOrgId = recipientOrganization.externalOrgId
  const recipientExternalTeamId = recipientTeam.externalTeamId

  const shareActor = requireHumanUoaActor(
    input.actor,
    project.organizationId,
    sourceExternalOrgId,
  )
  const sourceContext = {
    actor: input.actor,
    projectId: project.id,
    sourceOrganizationId: project.organizationId,
    sourceTeamId,
  }
  if (!(await deps.authorizeSourceManager(prisma, sourceContext))) deny('denied')
  if (!(await deps.isSharingPolicyEligible(prisma, {
    projectId: project.id,
    recipientOrganizationId: recipientOrganization.id,
    recipientTeamId: recipientTeam.id,
    sourceOrganizationId: project.organizationId,
    sourceTeamId,
  }))) deny('denied')

  if (input.scope === 'board') {
    const board = await prisma.board.findFirst({
      where: {
        id: input.boardId,
        organizationId: project.organizationId,
        projectId: project.id,
        sharePublication: { isNot: null },
      },
      select: { id: true },
    })
    if (!board) deny('invalid_target')
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await lockLiveShareTarget(tx, {
        boardId: input.boardId ?? null,
        projectId: project.id,
        scope: input.scope,
        sourceExternalOrgId,
        sourceExternalTeamId,
        sourceOrganizationId: project.organizationId,
        sourceTeamId,
      })
      const row = await tx.resourceShare.create({
        data: {
          boardId: input.boardId ?? null,
          createdByActingOrgRef: shareActor.actorOrganizationRef,
          createdBySubject: shareActor.actorSubject,
          createdAt: now,
          expiresAt: input.expiresAt ?? null,
          healthTransitionedAt: now,
          projectId: project.id,
          proposedAccess: input.access,
          recipientExternalOrgId,
          recipientExternalTeamId,
          recipientOrganizationId: recipientOrganization.id,
          recipientTeamId: recipientTeam.id,
          scope: input.scope,
          sourceExternalOrgId,
          sourceExternalTeamId,
          sourceOrganizationId: project.organizationId,
          sourceTeamId,
          targetBoardId: input.boardId ?? null,
          updatedAt: now,
        },
        select: RESOURCE_SHARE_AUDIT_SELECT,
      })
      await writeResourceShareLifecycleAudit(
        tx,
        row,
        'resource_share.offered',
        shareActor,
        shareActor.requestId,
        { previousAccess: null, previousStatus: null, reasonCode: 'offer_created' },
      )
      return toResourceShareTransitionResult(row)
    })
  } catch (error) {
    if (isUniqueConflict(error)) deny('conflict')
    throw error
  }
}

type ExistingShare = Awaited<ReturnType<typeof findShareForTransition>>

const findShareForTransition = async (prisma: PrismaClient, shareId: string) =>
  prisma.resourceShare.findUnique({
    where: { id: shareId },
    select: {
      ...RESOURCE_SHARE_AUDIT_SELECT,
      expiresAt: true,
      proposedAccess: true,
      proposedRevision: true,
      recipientExternalOrgId: true,
      recipientExternalTeamId: true,
      sourceExternalTeamId: true,
      sourceExternalOrgId: true,
      targetBoardId: true,
    },
  })

const authorizeRecipient = async (
  prisma: PrismaClient,
  share: NonNullable<ExistingShare>,
  actor: ResourceShareLifecycleActor,
  deps: ResourceShareLifecycleDependencies,
): Promise<ResourceShareAuditActor> => {
  const shareActor = requireHumanUoaActor(
    actor,
    share.recipientOrganizationId,
    share.recipientExternalOrgId,
  )
  if (!(await deps.authorizeRecipientTeamManager(prisma, {
    actor,
    recipientExternalOrgId: share.recipientExternalOrgId,
    recipientExternalTeamId: share.recipientExternalTeamId,
    recipientOrganizationId: share.recipientOrganizationId,
    recipientTeamId: share.recipientTeamId,
  }))) deny('denied')
  return shareActor
}

const transitionShare = async (
  prisma: PrismaClient,
  input: { shareId: string; expectedRevision: number },
  where: Prisma.ResourceShareWhereInput,
  data: Prisma.ResourceShareUpdateManyMutationInput,
  action: string,
  actor: ResourceShareAuditActor | null,
  requestId: string,
  reasonCode: string,
  previous: { access: ResourceShareAccess | null; status: ResourceShareTransitionResult['status'] },
  beforeUpdate?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<ResourceShareTransitionResult> => prisma.$transaction(async (tx) => {
  await beforeUpdate?.(tx)
  const changed = await tx.resourceShare.updateMany({
    where: { id: input.shareId, revision: input.expectedRevision, ...where },
    data: { ...data, revision: { increment: 1 } },
  })
  if (changed.count !== 1) deny('conflict')
  const row = await tx.resourceShare.findUnique({
    where: { id: input.shareId },
    select: RESOURCE_SHARE_AUDIT_SELECT,
  })
  if (!row) throw new ResourceShareLifecycleError('not_found')
  await writeResourceShareLifecycleAudit(tx, row, action, actor, requestId, {
    previousAccess: previous.access,
    previousStatus: previous.status,
    reasonCode,
  })
  return toResourceShareTransitionResult(row)
})

export type ResourceShareDecisionInput = {
  actor: ResourceShareLifecycleActor
  expectedRevision: number
  shareId: string
}

export const acceptResourceShare = async (
  prisma: PrismaClient,
  input: ResourceShareDecisionInput,
  deps: ResourceShareLifecycleDependencies,
): Promise<ResourceShareTransitionResult> => {
  sharingEnabled(deps)
  const share = await findShareForTransition(prisma, input.shareId)
  if (!share) throw new ResourceShareLifecycleError('not_found')
  const actor = await authorizeRecipient(prisma, share, input.actor, deps)
  if (!(await deps.isSharingPolicyEligible(prisma, {
    projectId: share.projectId,
    recipientOrganizationId: share.recipientOrganizationId,
    recipientTeamId: share.recipientTeamId,
    sourceOrganizationId: share.sourceOrganizationId,
    sourceTeamId: share.sourceTeamId,
  }))) deny('denied')
  const now = deps.now?.() ?? new Date()
  return transitionShare(
    prisma,
    input,
    { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], status: 'pending' },
    {
      acceptedAt: now,
      acceptedByActingOrgRef: actor.actorOrganizationRef,
      acceptedBySubject: actor.actorSubject,
      effectiveAccess: share.proposedAccess,
      effectiveRevision: share.proposedRevision,
      status: 'active',
    },
    'resource_share.accepted',
    actor,
    actor.requestId,
    'recipient_accepted',
    { access: share.effectiveAccess, status: share.status },
    (tx) => lockLiveShareTarget(tx, {
      boardId: share.targetBoardId,
      projectId: share.projectId,
      scope: share.scope,
      sourceExternalOrgId: share.sourceExternalOrgId,
      sourceExternalTeamId: share.sourceExternalTeamId,
      sourceOrganizationId: share.sourceOrganizationId,
      sourceTeamId: share.sourceTeamId,
    }),
  )
}

export const declineResourceShare = async (
  prisma: PrismaClient,
  input: ResourceShareDecisionInput,
  deps: ResourceShareLifecycleDependencies,
): Promise<ResourceShareTransitionResult> => {
  const share = await findShareForTransition(prisma, input.shareId)
  if (!share) throw new ResourceShareLifecycleError('not_found')
  const actor = await authorizeRecipient(prisma, share, input.actor, deps)
  const now = deps.now?.() ?? new Date()
  return transitionShare(
    prisma,
    input,
    { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], status: 'pending' },
    {
      declinedAt: now,
      declinedByActingOrgRef: actor.actorOrganizationRef,
      declinedBySubject: actor.actorSubject,
      status: 'declined',
    },
    'resource_share.declined',
    actor,
    actor.requestId,
    'recipient_declined',
    { access: share.effectiveAccess, status: share.status },
  )
}

export const revokeResourceShare = async (
  prisma: PrismaClient,
  input: ResourceShareDecisionInput,
  deps: ResourceShareLifecycleDependencies,
): Promise<ResourceShareTransitionResult> => {
  const share = await findShareForTransition(prisma, input.shareId)
  if (!share) throw new ResourceShareLifecycleError('not_found')
  let actor: ResourceShareAuditActor
  if (input.actor.tenant.organizationId === share.sourceOrganizationId) {
    actor = requireHumanUoaActor(input.actor, share.sourceOrganizationId, share.sourceExternalOrgId)
    if (!(await deps.authorizeSourceManager(prisma, {
      actor: input.actor,
      projectId: share.projectId,
      sourceOrganizationId: share.sourceOrganizationId,
      sourceTeamId: share.sourceTeamId,
    }))) deny('denied')
  } else {
    actor = await authorizeRecipient(prisma, share, input.actor, deps)
  }
  const now = deps.now?.() ?? new Date()
  return transitionShare(
    prisma,
    input,
    { status: { in: ['active', 'pending'] } },
    {
      revokedAt: now,
      revokedByActingOrgRef: actor.actorOrganizationRef,
      revokedBySubject: actor.actorSubject,
      status: 'revoked',
    },
    'resource_share.revoked',
    actor,
    actor.requestId,
    'manager_revoked',
    { access: share.effectiveAccess, status: share.status },
  )
}

export const expireResourceShare = async (
  prisma: PrismaClient,
  input: { expectedRevision: number; requestId: string; shareId: string },
  deps: Pick<ResourceShareLifecycleDependencies, 'now'>,
): Promise<ResourceShareTransitionResult> => {
  const now = deps.now?.() ?? new Date()
  const share = await findShareForTransition(prisma, input.shareId)
  if (!share) throw new ResourceShareLifecycleError('not_found')
  return transitionShare(
    prisma,
    input,
    { expiresAt: { lte: now }, status: { in: ['active', 'pending'] } },
    { expiredAt: now, status: 'expired' },
    'resource_share.expired',
    null,
    input.requestId,
    'expiry_elapsed',
    { access: share.effectiveAccess, status: share.status },
  )
}
