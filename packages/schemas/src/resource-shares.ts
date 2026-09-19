import { z } from 'zod'

import {
  BoardIdSchema,
  IterationIdSchema,
  KnowledgePageIdSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  ResourceShareIdSchema,
  TaskFieldDefinitionIdSchema,
  TeamIdSchema,
} from './ids.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

export const ResourceShareScopeSchema = z.enum(['project', 'board'])
export type ResourceShareScope = z.infer<typeof ResourceShareScopeSchema>

export const ResourceShareAccessSchema = z.enum(['read', 'write'])
export type ResourceShareAccess = z.infer<typeof ResourceShareAccessSchema>

export const ResourceShareStatusSchema = z.enum([
  'pending',
  'active',
  'declined',
  'revoked',
  'expired',
])
export type ResourceShareStatus = z.infer<typeof ResourceShareStatusSchema>

export const ResourceShareHealthSchema = z.enum(['healthy', 'suspended'])
export type ResourceShareHealth = z.infer<typeof ResourceShareHealthSchema>

export const ResourceShareHealthReasonCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,79}$/)

const StableUoaReferenceSchema = NonEmptyStringSchema.trim().max(255)
const PositiveRevisionSchema = z.number().int().min(1)

const ResourceShareRecordBaseSchema = z
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

const addIssue = (context: z.RefinementCtx, path: (string | number)[], message: string) => {
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

export const ResourceShareRecordSchema = ResourceShareRecordBaseSchema.superRefine(
  (share, context) => {
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
  },
)
export type ResourceShareRecord = z.infer<typeof ResourceShareRecordSchema>

const IMMUTABLE_RESOURCE_SHARE_FIELDS = [
  'id',
  'scope',
  'sourceOrganizationId',
  'sourceExternalOrgId',
  'sourceTeamId',
  'sourceExternalTeamId',
  'projectId',
  'targetBoardId',
  'recipientOrganizationId',
  'recipientExternalOrgId',
  'recipientTeamId',
  'recipientExternalTeamId',
  'createdBySubject',
  'createdByActingOrgRef',
  'createdAt',
] as const satisfies readonly (keyof ResourceShareRecord)[]

const actorAuditChanged = (
  previous: readonly (string | null)[],
  next: readonly (string | null)[],
) => previous.some((value, index) => value !== next[index])

export const ResourceShareStateTransitionSchema = z
  .object({
    previous: ResourceShareRecordSchema,
    next: ResourceShareRecordSchema,
  })
  .strict()
  .superRefine(({ previous, next }, context) => {
    for (const field of IMMUTABLE_RESOURCE_SHARE_FIELDS) {
      if (previous[field] !== next[field]) {
        addIssue(context, ['next', field], `${field} is immutable`)
      }
    }
    if (next.revision <= previous.revision) {
      addIssue(context, ['next', 'revision'], 'revision must increase')
    }
    if (
      previous.declinedAt !== null &&
      actorAuditChanged(
        [previous.declinedBySubject, previous.declinedByActingOrgRef, previous.declinedAt],
        [next.declinedBySubject, next.declinedByActingOrgRef, next.declinedAt],
      )
    ) {
      addIssue(context, ['next', 'declinedAt'], 'decline audit is append-only')
    }
    if (
      previous.revokedAt !== null &&
      actorAuditChanged(
        [previous.revokedBySubject, previous.revokedByActingOrgRef, previous.revokedAt],
        [next.revokedBySubject, next.revokedByActingOrgRef, next.revokedAt],
      )
    ) {
      addIssue(context, ['next', 'revokedAt'], 'revocation audit is append-only')
    }
    if (previous.expiredAt !== null && next.expiredAt !== previous.expiredAt) {
      addIssue(context, ['next', 'expiredAt'], 'expiry audit is append-only')
    }
    const acceptanceAuditChanged = actorAuditChanged(
      [previous.acceptedBySubject, previous.acceptedByActingOrgRef, previous.acceptedAt],
      [next.acceptedBySubject, next.acceptedByActingOrgRef, next.acceptedAt],
    )
    const effectiveRevisionIncreased =
      next.effectiveRevision !== null &&
      (previous.effectiveRevision === null ||
        next.effectiveRevision > previous.effectiveRevision)
    if (acceptanceAuditChanged && !effectiveRevisionIncreased) {
      addIssue(
        context,
        ['next', 'acceptedAt'],
        'acceptance audit changes require a higher effective revision',
      )
    }
    if (next.healthRevision < previous.healthRevision) {
      addIssue(context, ['next', 'healthRevision'], 'health revision cannot decrease')
    }
    if (
      (next.health !== previous.health ||
        next.healthReasonCode !== previous.healthReasonCode) &&
      next.healthRevision <= previous.healthRevision
    ) {
      addIssue(context, ['next', 'healthRevision'], 'health transitions must increase revision')
    }
  })
export type ResourceShareStateTransition = z.infer<
  typeof ResourceShareStateTransitionSchema
>

export const BoardSharedFieldRecordSchema = z
  .object({
    fieldDefinitionId: TaskFieldDefinitionIdSchema,
    allowedOptionIds: NonEmptyStringSchema.array(),
  })
  .strict()
  .superRefine((field, context) => {
    if (new Set(field.allowedOptionIds).size !== field.allowedOptionIds.length) {
      addIssue(context, ['allowedOptionIds'], 'allowed option ids must be unique')
    }
  })
export type BoardSharedFieldRecord = z.infer<typeof BoardSharedFieldRecordSchema>

export const BoardSharedIterationRecordSchema = z
  .object({ iterationId: IterationIdSchema })
  .strict()
export type BoardSharedIterationRecord = z.infer<typeof BoardSharedIterationRecordSchema>

export const BoardSharedResourceRecordSchema = z
  .object({ pageId: KnowledgePageIdSchema })
  .strict()
export type BoardSharedResourceRecord = z.infer<typeof BoardSharedResourceRecordSchema>

export const BoardSharePublicationRecordSchema = z
  .object({
    boardId: BoardIdSchema,
    projectId: ProjectIdSchema,
    sourceOrganizationId: OrganizationIdSchema,
    revision: PositiveRevisionSchema,
    fields: BoardSharedFieldRecordSchema.array(),
    iterations: BoardSharedIterationRecordSchema.array(),
    resources: BoardSharedResourceRecordSchema.array(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
export type BoardSharePublicationRecord = z.infer<
  typeof BoardSharePublicationRecordSchema
>
