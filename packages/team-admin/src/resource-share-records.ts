import type { Prisma } from '@prisma/client'
import {
  BoardSharePublicationRecordSchema,
  type BoardSharePublicationRecord,
  ResourceShareViewSchema,
  type ResourceShareView,
} from '@nessie/schemas'

import {
  ResourceSharePersistenceRecordSchema,
  type ResourceSharePersistenceRecord,
} from './resource-share-persistence.js'

/**
 * The complete persisted grant contract, with no joined identity, membership,
 * label, role, or commercial data. Reuse this select at every database read so
 * the strict record parser sees one stable shape.
 */
export const resourceShareRecordSelect = {
  id: true,
  scope: true,
  sourceOrganizationId: true,
  sourceExternalOrgId: true,
  sourceTeamId: true,
  sourceExternalTeamId: true,
  projectId: true,
  targetBoardId: true,
  boardId: true,
  recipientOrganizationId: true,
  recipientExternalOrgId: true,
  recipientTeamId: true,
  recipientExternalTeamId: true,
  proposedAccess: true,
  proposedRevision: true,
  effectiveAccess: true,
  effectiveRevision: true,
  status: true,
  revision: true,
  expiresAt: true,
  createdBySubject: true,
  createdByActingOrgRef: true,
  acceptedBySubject: true,
  acceptedByActingOrgRef: true,
  acceptedAt: true,
  declinedBySubject: true,
  declinedByActingOrgRef: true,
  declinedAt: true,
  revokedBySubject: true,
  revokedByActingOrgRef: true,
  revokedAt: true,
  expiredAt: true,
  health: true,
  healthReasonCode: true,
  healthRevision: true,
  healthTransitionedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ResourceShareSelect

export type ResourceShareRecordRow = Prisma.ResourceShareGetPayload<{
  select: typeof resourceShareRecordSelect
}>

export const mapResourceSharePersistenceRecord = (
  row: ResourceShareRecordRow,
): ResourceSharePersistenceRecord =>
  ResourceSharePersistenceRecordSchema.parse({
    ...row,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    declinedAt: row.declinedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    expiredAt: row.expiredAt?.toISOString() ?? null,
    healthTransitionedAt: row.healthTransitionedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })

export type ResourceShareViewCapabilitiesInput = {
  accept: boolean
  decline: boolean
  revoke: boolean
}

/**
 * Build the only public share DTO field by field. Capability decisions come
 * from the caller's live authority check; persistence ids, UOA references and
 * actor subjects have no path into this projection.
 */
export const presentResourceShare = (
  row: ResourceShareRecordRow,
  capabilities: ResourceShareViewCapabilitiesInput,
): ResourceShareView => ResourceShareViewSchema.parse({
  capabilities,
  effectiveAccess: row.effectiveAccess,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  health: row.health,
  healthReasonCode: row.healthReasonCode,
  healthRevision: row.healthRevision,
  id: row.id,
  proposedAccess: row.proposedAccess,
  revision: row.revision,
  scope: row.scope,
  status: row.status,
})

/**
 * A board's whole publication fence. Child rows are ordered by their stable
 * resource id so repeated reads have one deterministic contract projection.
 */
export const boardSharePublicationRecordSelect = {
  boardId: true,
  projectId: true,
  sourceOrganizationId: true,
  revision: true,
  fields: {
    orderBy: { fieldDefinitionId: 'asc' },
    select: {
      fieldDefinitionId: true,
      allowedOptionIds: true,
    },
  },
  iterations: {
    orderBy: { iterationId: 'asc' },
    select: { iterationId: true },
  },
  resources: {
    orderBy: { pageId: 'asc' },
    select: { pageId: true },
  },
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BoardSharePublicationSelect

export type BoardSharePublicationRecordRow =
  Prisma.BoardSharePublicationGetPayload<{
    select: typeof boardSharePublicationRecordSelect
  }>

export const mapBoardSharePublicationRecord = (
  row: BoardSharePublicationRecordRow,
): BoardSharePublicationRecord =>
  BoardSharePublicationRecordSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
