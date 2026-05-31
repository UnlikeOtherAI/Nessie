import { z } from 'zod'

const NonEmptyStringSchema = z.string().trim().min(1)
const UuidSchema = z.string().uuid()
const JsonRecordSchema = z.record(z.string(), z.unknown())

export const KnowledgeVisibilitySchema = z.enum([
  'private',
  'channel',
  'team',
  'project',
  'organization',
])
export const KnowledgeSensitivityTierSchema = z.enum([
  'normal',
  'sensitive',
  'restricted',
])
export const KnowledgePageStatusSchema = z.enum(['draft', 'published', 'archived'])
export const KnowledgeAuthorTypeSchema = z.enum(['user', 'agent'])

const OptionalScopeSchema = z.object({
  projectId: UuidSchema.optional(),
  teamId: UuidSchema.nullable().optional(),
  channelId: UuidSchema.nullable().optional(),
  threadId: UuidSchema.nullable().optional(),
  userId: UuidSchema.nullable().optional(),
  visibility: KnowledgeVisibilitySchema.optional(),
  sensitivityTier: KnowledgeSensitivityTierSchema.optional(),
  privateToAgentId: UuidSchema.nullable().optional(),
})

export const KnowledgePageVersionRecordSchema = z.object({
  id: UuidSchema,
  pageId: UuidSchema,
  versionNumber: z.number().int().positive(),
  body: z.string().nullable(),
  bodyRef: z.string().nullable(),
  authorType: KnowledgeAuthorTypeSchema,
  authorId: NonEmptyStringSchema,
  changeComment: z.string().nullable(),
  createdAt: NonEmptyStringSchema,
})

export const KnowledgeResponseEnvelopeSchema = z.object({
  policyChainTrace: z.array(z.string()),
  sourceRef: NonEmptyStringSchema,
  visibilityReason: NonEmptyStringSchema,
})

export const KnowledgeSpaceRecordSchema = OptionalScopeSchema.extend({
  id: UuidSchema,
  name: NonEmptyStringSchema,
  description: z.string().nullable(),
  metadata: JsonRecordSchema.nullable(),
  organizationId: UuidSchema,
  projectId: UuidSchema,
  visibility: KnowledgeVisibilitySchema,
  sensitivityTier: KnowledgeSensitivityTierSchema,
  createdBy: NonEmptyStringSchema,
  deletedAt: z.string().nullable(),
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
}).merge(KnowledgeResponseEnvelopeSchema)

export const KnowledgePageRecordSchema = OptionalScopeSchema.extend({
  id: UuidSchema,
  spaceId: UuidSchema,
  title: NonEmptyStringSchema,
  summary: z.string().nullable(),
  metadata: JsonRecordSchema.nullable(),
  parentPageId: UuidSchema.nullable(),
  position: z.number().int().nonnegative(),
  status: KnowledgePageStatusSchema,
  labels: z.array(NonEmptyStringSchema),
  latestVersion: KnowledgePageVersionRecordSchema.nullable(),
  publishedVersion: KnowledgePageVersionRecordSchema.nullable(),
  publishedVersionId: UuidSchema.nullable(),
  organizationId: UuidSchema,
  projectId: UuidSchema,
  visibility: KnowledgeVisibilitySchema,
  sensitivityTier: KnowledgeSensitivityTierSchema,
  createdBy: NonEmptyStringSchema,
  deletedAt: z.string().nullable(),
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
}).merge(KnowledgeResponseEnvelopeSchema)

export const KnowledgeSearchHitSchema = z.object({
  page: KnowledgePageRecordSchema,
  snippet: NonEmptyStringSchema,
})

export const CreateKnowledgeSpaceBodySchema = OptionalScopeSchema.extend({
  name: NonEmptyStringSchema.max(200),
  description: z.string().max(2000).nullable().optional(),
  metadata: JsonRecordSchema.nullable().optional(),
})

export const UpdateKnowledgeSpaceBodySchema = z.object({
  name: NonEmptyStringSchema.max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  metadata: JsonRecordSchema.nullable().optional(),
  visibility: KnowledgeVisibilitySchema.optional(),
  sensitivityTier: KnowledgeSensitivityTierSchema.optional(),
})

export const CreateKnowledgePageBodySchema = OptionalScopeSchema.extend({
  title: NonEmptyStringSchema.max(240),
  summary: z.string().max(2000).nullable().optional(),
  metadata: JsonRecordSchema.nullable().optional(),
  parentPageId: UuidSchema.nullable().optional(),
  position: z.number().int().nonnegative().optional(),
  labels: z.array(NonEmptyStringSchema.max(80)).max(32).optional(),
  body: z.string().nullable().optional(),
  bodyRef: z.string().nullable().optional(),
  authorType: KnowledgeAuthorTypeSchema.optional(),
  changeComment: z.string().max(1000).nullable().optional(),
})

export const UpdateKnowledgePageBodySchema = z.object({
  title: NonEmptyStringSchema.max(240).optional(),
  summary: z.string().max(2000).nullable().optional(),
  metadata: JsonRecordSchema.nullable().optional(),
  labels: z.array(NonEmptyStringSchema.max(80)).max(32).optional(),
  body: z.string().nullable().optional(),
  bodyRef: z.string().nullable().optional(),
  visibility: KnowledgeVisibilitySchema.optional(),
  sensitivityTier: KnowledgeSensitivityTierSchema.optional(),
  authorType: KnowledgeAuthorTypeSchema.optional(),
  changeComment: z.string().max(1000).nullable().optional(),
})

export const MoveKnowledgePageBodySchema = z.object({
  parentPageId: UuidSchema.nullable().optional(),
  position: z.number().int().nonnegative(),
})

export const RestoreKnowledgePageVersionBodySchema = z.object({
  authorType: KnowledgeAuthorTypeSchema.optional(),
  changeComment: z.string().max(1000).nullable().optional(),
})

export const SearchKnowledgePagesBodySchema = z.object({
  query: z.string().max(500).optional(),
  labels: z.array(NonEmptyStringSchema.max(80)).max(32).optional(),
  projectId: UuidSchema.optional(),
  spaceId: UuidSchema.optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
})

export const KnowledgeListQuerySchema = z.object({
  cursor: z.string().optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  projectId: UuidSchema.optional(),
})

export type CreateKnowledgePageBody = z.infer<typeof CreateKnowledgePageBodySchema>
export type CreateKnowledgeSpaceBody = z.infer<typeof CreateKnowledgeSpaceBodySchema>
export type MoveKnowledgePageBody = z.infer<typeof MoveKnowledgePageBodySchema>
export type RestoreKnowledgePageVersionBody =
  z.infer<typeof RestoreKnowledgePageVersionBodySchema>
export type SearchKnowledgePagesBody = z.infer<typeof SearchKnowledgePagesBodySchema>
export type UpdateKnowledgePageBody = z.infer<typeof UpdateKnowledgePageBodySchema>
export type UpdateKnowledgeSpaceBody = z.infer<typeof UpdateKnowledgeSpaceBodySchema>
