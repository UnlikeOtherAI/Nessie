import { z } from 'zod'
import {
  BoardIdSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  ResourceShareAccessSchema,
  ResourceShareHealthReasonCodeSchema,
  ResourceShareHealthSchema,
  ResourceShareIdSchema,
  ResourceShareScopeSchema,
  ResourceShareStatusSchema,
  TeamIdSchema,
} from '@nessie/schemas'

const StableUoaReferenceSchema = z.string().trim().min(1).max(255)
const PositiveRevisionSchema = z.number().int().min(1)
const TimestampSchema = z.string().min(1)

const addIssue = (context: z.RefinementCtx, path: string[], message: string) => {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message })
}

const validateActorTriplet = (
  context: z.RefinementCtx,
  values: readonly (string | null)[],
  path: string,
) => {
  const present = values.filter((value) => value !== null).length
  if (present !== 0 && present !== values.length) {
    addIssue(context, [path], 'actor subject, acting organisation and timestamp must appear together')
  }
}

/** Server-only validation for the complete persistence row. */
export const ResourceSharePersistenceRecordSchema = z
  .object({
    id: ResourceShareIdSchema,
    scope: ResourceShareScopeSchema,
    sourceOrganizationId: OrganizationIdSchema,
    sourceExternalOrgId: StableUoaReferenceSchema,
    sourceTeamId: TeamIdSchema,
    sourceExternalTeamId: StableUoaReferenceSchema,
    projectId: ProjectIdSchema,
    targetBoardId: BoardIdSchema.nullable(),
    boardId: BoardIdSchema.nullable(),
    recipientOrganizationId: OrganizationIdSchema,
    recipientExternalOrgId: StableUoaReferenceSchema,
    recipientTeamId: TeamIdSchema,
    recipientExternalTeamId: StableUoaReferenceSchema,
    proposedAccess: ResourceShareAccessSchema,
    proposedRevision: PositiveRevisionSchema,
    effectiveAccess: ResourceShareAccessSchema.nullable(),
    effectiveRevision: PositiveRevisionSchema.nullable(),
    status: ResourceShareStatusSchema,
    revision: PositiveRevisionSchema,
    expiresAt: TimestampSchema.nullable(),
    createdBySubject: StableUoaReferenceSchema,
    createdByActingOrgRef: StableUoaReferenceSchema,
    acceptedBySubject: StableUoaReferenceSchema.nullable(),
    acceptedByActingOrgRef: StableUoaReferenceSchema.nullable(),
    acceptedAt: TimestampSchema.nullable(),
    declinedBySubject: StableUoaReferenceSchema.nullable(),
    declinedByActingOrgRef: StableUoaReferenceSchema.nullable(),
    declinedAt: TimestampSchema.nullable(),
    revokedBySubject: StableUoaReferenceSchema.nullable(),
    revokedByActingOrgRef: StableUoaReferenceSchema.nullable(),
    revokedAt: TimestampSchema.nullable(),
    expiredAt: TimestampSchema.nullable(),
    health: ResourceShareHealthSchema,
    healthReasonCode: ResourceShareHealthReasonCodeSchema.nullable(),
    healthRevision: PositiveRevisionSchema,
    healthTransitionedAt: TimestampSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((share, context) => {
    if (share.scope === 'project') {
      if (share.targetBoardId !== null || share.boardId !== null) {
        addIssue(context, ['targetBoardId'], 'project scope cannot name a board')
      }
    } else if (share.targetBoardId === null) {
      addIssue(context, ['targetBoardId'], 'board scope requires an immutable target board')
    } else if (share.boardId !== null && share.boardId !== share.targetBoardId) {
      addIssue(context, ['boardId'], 'the live board must match the immutable target')
    } else if (
      (share.status === 'pending' || share.status === 'active') &&
      share.boardId === null
    ) {
      addIssue(context, ['boardId'], 'a live board offer or grant requires board ancestry')
    }
    if (
      share.sourceOrganizationId === share.recipientOrganizationId ||
      share.sourceExternalOrgId === share.recipientExternalOrgId
    ) {
      addIssue(context, ['recipientOrganizationId'], 'source and recipient organisations must differ')
    }
    if (share.proposedRevision > share.revision) {
      addIssue(context, ['proposedRevision'], 'proposed revision cannot exceed row revision')
    }
    if ((share.effectiveAccess === null) !== (share.effectiveRevision === null)) {
      addIssue(context, ['effectiveAccess'], 'effective access and revision must appear together')
    }
    if (
      share.effectiveRevision !== null &&
      share.effectiveRevision > share.proposedRevision
    ) {
      addIssue(context, ['effectiveRevision'], 'effective revision cannot exceed proposed revision')
    }
    if (
      share.effectiveAccess !== null &&
      share.effectiveAccess !== share.proposedAccess &&
      !(
        share.effectiveAccess === 'read' &&
        share.proposedAccess === 'write' &&
        share.effectiveRevision !== null &&
        share.effectiveRevision < share.proposedRevision
      )
    ) {
      addIssue(context, ['proposedAccess'], 'only a pending read-to-write widening may differ')
    }

    validateActorTriplet(
      context,
      [share.acceptedBySubject, share.acceptedByActingOrgRef, share.acceptedAt],
      'acceptedBySubject',
    )
    validateActorTriplet(
      context,
      [share.declinedBySubject, share.declinedByActingOrgRef, share.declinedAt],
      'declinedBySubject',
    )
    validateActorTriplet(
      context,
      [share.revokedBySubject, share.revokedByActingOrgRef, share.revokedAt],
      'revokedBySubject',
    )
    if (
      share.status === 'pending' &&
      (share.effectiveAccess !== null || share.acceptedAt !== null)
    ) {
      addIssue(context, ['effectiveAccess'], 'pending offers have no accepted access')
    }
    if (
      share.status === 'active' &&
      (share.effectiveAccess === null || share.acceptedAt === null)
    ) {
      addIssue(context, ['status'], 'active grants require accepted effective access')
    }
    if (
      share.status === 'declined' &&
      (share.effectiveAccess !== null || share.acceptedAt !== null)
    ) {
      addIssue(context, ['status'], 'declined offers were never accepted')
    }
    const terminalTimestamps = {
      declined: share.declinedAt,
      revoked: share.revokedAt,
      expired: share.expiredAt,
    } as const
    for (const [status, timestamp] of Object.entries(terminalTimestamps)) {
      if ((share.status === status) !== (timestamp !== null)) {
        addIssue(context, [`${status}At`], `${status} timestamp must match lifecycle status`)
      }
    }
    if ((share.health === 'healthy') !== (share.healthReasonCode === null)) {
      addIssue(context, ['healthReasonCode'], 'only suspended shares carry a health reason')
    }
  })

export type ResourceSharePersistenceRecord = z.infer<
  typeof ResourceSharePersistenceRecordSchema
>
