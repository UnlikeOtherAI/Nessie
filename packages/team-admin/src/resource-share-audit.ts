import { Prisma } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'
import type {
  ResourceShareAccess,
  ResourceShareScope,
  ResourceShareStatus,
} from '@nessie/schemas'

export type ResourceShareAuditActor = {
  actorId: string
  actorOrganizationRef: string
  actorSubject: string
  requestId: string
}

export type ResourceShareAuditRow = {
  effectiveAccess: ResourceShareAccess | null
  id: string
  projectId: string
  proposedAccess: ResourceShareAccess
  recipientOrganizationId: string
  recipientTeamId: string
  revision: number
  scope: ResourceShareScope
  sourceOrganizationId: string
  sourceTeamId: string
  status: ResourceShareStatus
}

export type ResourceShareTransitionResult = {
  id: string
  revision: number
  status: ResourceShareStatus
}

export type ResourceShareAuditTransition = {
  previousAccess: ResourceShareAccess | null
  previousStatus: ResourceShareStatus | null
  reasonCode: string
}

export const RESOURCE_SHARE_AUDIT_SELECT = {
  effectiveAccess: true,
  id: true,
  projectId: true,
  proposedAccess: true,
  recipientOrganizationId: true,
  recipientTeamId: true,
  revision: true,
  scope: true,
  sourceOrganizationId: true,
  sourceTeamId: true,
  status: true,
} as const satisfies Prisma.ResourceShareSelect

/**
 * Append both tenant views to their hash chains inside the grant transaction.
 * Sorting the chain locks prevents two cross-tenant transitions from acquiring
 * the same pair in opposite order.
 */
export const writeResourceShareLifecycleAudit = async (
  tx: Prisma.TransactionClient,
  row: ResourceShareAuditRow,
  action: string,
  actor: ResourceShareAuditActor | null,
  requestId: string,
  transition: ResourceShareAuditTransition,
): Promise<void> => {
  const organizations = [
    {
      counterpartyOrganizationId: row.recipientOrganizationId,
      organizationId: row.sourceOrganizationId,
      projectId: row.projectId,
      teamId: row.sourceTeamId,
    },
    {
      counterpartyOrganizationId: row.sourceOrganizationId,
      organizationId: row.recipientOrganizationId,
      projectId: null,
      teamId: row.recipientTeamId,
    },
  ].sort((left, right) => left.organizationId.localeCompare(right.organizationId))

  for (const organization of organizations) {
    await writeAuditEntryInTransaction(tx, {
      action,
      actorId: actor?.actorId ?? 'resource-share-expiry',
      actorType: actor ? 'user' : 'system',
      metadata: {
        ...(actor ? {
          actorOrganizationRef: actor.actorOrganizationRef,
          actorSubject: actor.actorSubject,
        } : {}),
        access: row.effectiveAccess,
        counterpartyOrganizationId: organization.counterpartyOrganizationId,
        previousAccess: transition.previousAccess,
        previousStatus: transition.previousStatus,
        proposedAccess: row.proposedAccess,
        reasonCode: transition.reasonCode,
        recipientOrganizationId: row.recipientOrganizationId,
        recipientTeamId: row.recipientTeamId,
        revision: row.revision,
        scope: row.scope,
        sourceOrganizationId: row.sourceOrganizationId,
        sourceTeamId: row.sourceTeamId,
        status: row.status,
      },
      organizationId: organization.organizationId,
      outcome: 'success',
      projectId: organization.projectId,
      requestId,
      resourceId: row.id,
      resourceType: 'resource_share',
      teamId: organization.teamId,
    })
  }
}

export const toResourceShareTransitionResult = (
  row: ResourceShareAuditRow,
): ResourceShareTransitionResult => ({
  id: row.id,
  revision: row.revision,
  status: row.status,
})
