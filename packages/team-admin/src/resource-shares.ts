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
import {
  denyResourceShareLifecycle as deny,
  ResourceShareLifecycleError,
} from './resource-share-lifecycle-errors.js'
import {
  findResourceShareAtRevision,
  transitionResourceShare,
  type ResourceShareTransitionRow,
} from './resource-share-transition.js'

export type { ResourceShareTransitionResult } from './resource-share-audit.js'
export {
  ResourceShareLifecycleError,
  type ResourceShareLifecycleErrorCode,
} from './resource-share-lifecycle-errors.js'

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
      const databaseClock = await tx.$queryRaw<{ now: Date }[]>`
        SELECT CURRENT_TIMESTAMP AS "now"
      `
      const databaseNow = databaseClock[0]?.now
      if (!databaseNow || (input.expiresAt && input.expiresAt <= databaseNow)) {
        deny('invalid_target')
      }
      const row = await tx.resourceShare.create({
        data: {
          boardId: input.boardId ?? null,
          createdByActingOrgRef: shareActor.actorOrganizationRef,
          createdBySubject: shareActor.actorSubject,
          expiresAt: input.expiresAt ?? null,
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

const authorizeRecipient = async (
  prisma: PrismaClient,
  share: ResourceShareTransitionRow,
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
  const share = await findResourceShareAtRevision(
    prisma,
    input.shareId,
    input.expectedRevision,
  )
  const actor = await authorizeRecipient(prisma, share, input.actor, deps)
  if (!(await deps.isSharingPolicyEligible(prisma, {
    projectId: share.projectId,
    recipientOrganizationId: share.recipientOrganizationId,
    recipientTeamId: share.recipientTeamId,
    sourceOrganizationId: share.sourceOrganizationId,
    sourceTeamId: share.sourceTeamId,
  }))) deny('denied')
  const now = deps.now?.() ?? new Date()
  return transitionResourceShare(
    prisma,
    input,
    { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], status: 'pending' },
    () => ({
      acceptedAt: now,
      acceptedByActingOrgRef: actor.actorOrganizationRef,
      acceptedBySubject: actor.actorSubject,
      effectiveAccess: share.proposedAccess,
      effectiveRevision: share.proposedRevision,
      status: 'active',
    }),
    'resource_share.accepted',
    actor,
    actor.requestId,
    'recipient_accepted',
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
  const share = await findResourceShareAtRevision(
    prisma,
    input.shareId,
    input.expectedRevision,
  )
  const actor = await authorizeRecipient(prisma, share, input.actor, deps)
  const now = deps.now?.() ?? new Date()
  return transitionResourceShare(
    prisma,
    input,
    { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], status: 'pending' },
    () => ({
      declinedAt: now,
      declinedByActingOrgRef: actor.actorOrganizationRef,
      declinedBySubject: actor.actorSubject,
      status: 'declined',
    }),
    'resource_share.declined',
    actor,
    actor.requestId,
    'recipient_declined',
  )
}

export const revokeResourceShare = async (
  prisma: PrismaClient,
  input: ResourceShareDecisionInput,
  deps: ResourceShareLifecycleDependencies,
): Promise<ResourceShareTransitionResult> => {
  const share = await findResourceShareAtRevision(
    prisma,
    input.shareId,
    input.expectedRevision,
  )
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
  return transitionResourceShare(
    prisma,
    input,
    { status: { in: ['active', 'pending'] } },
    () => ({
      revokedAt: now,
      revokedByActingOrgRef: actor.actorOrganizationRef,
      revokedBySubject: actor.actorSubject,
      status: 'revoked',
    }),
    'resource_share.revoked',
    actor,
    actor.requestId,
    'manager_revoked',
  )
}

export const expireResourceShare = async (
  prisma: PrismaClient,
  input: { expectedRevision: number; requestId: string; shareId: string },
  deps: Pick<ResourceShareLifecycleDependencies, 'now'>,
): Promise<ResourceShareTransitionResult> => {
  const now = deps.now?.() ?? new Date()
  await findResourceShareAtRevision(prisma, input.shareId, input.expectedRevision)
  return transitionResourceShare(
    prisma,
    input,
    { expiresAt: { lte: now }, status: { in: ['active', 'pending'] } },
    () => ({ expiredAt: now, status: 'expired' }),
    'resource_share.expired',
    null,
    input.requestId,
    'expiry_elapsed',
  )
}
