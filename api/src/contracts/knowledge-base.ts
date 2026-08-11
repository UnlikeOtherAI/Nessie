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
  writeRestricted: z.boolean(),
  memberUserIds: z.array(UuidSchema),
  // The requesting actor's effective write permission on this space.
  canWrite: z.boolean(),
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
  // Set when this page is a ticket-bound document (or a ticket's document folder).
  taskId: UuidSchema.nullable(),
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

export const KnowledgeSearchPassageSchema = z.object({
  content: NonEmptyStringSchema,
  endOffset: z.number().int().nonnegative(),
  score: z.number(),
  startOffset: z.number().int().nonnegative(),
})

export const KnowledgeSearchHitSchema = z.object({
  page: KnowledgePageRecordSchema,
  snippet: NonEmptyStringSchema,
  passages: z.array(KnowledgeSearchPassageSchema).optional(),
  score: z.number().optional(),
})

export const CreateKnowledgeSpaceBodySchema = OptionalScopeSchema.extend({
  name: NonEmptyStringSchema.max(200),
  description: z.string().max(2000).nullable().optional(),
  metadata: JsonRecordSchema.nullable().optional(),
  writeRestricted: z.boolean().optional(),
  memberUserIds: z.array(UuidSchema).max(500).optional(),
  memberAgentIds: z.array(UuidSchema).max(64).optional(),
})

export const UpdateKnowledgeSpaceBodySchema = z.object({
  name: NonEmptyStringSchema.max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  metadata: JsonRecordSchema.nullable().optional(),
  visibility: KnowledgeVisibilitySchema.optional(),
  sensitivityTier: KnowledgeSensitivityTierSchema.optional(),
  writeRestricted: z.boolean().optional(),
  memberUserIds: z.array(UuidSchema).max(500).optional(),
  memberAgentIds: z.array(UuidSchema).max(64).optional(),
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
  changeComment: z.string().max(1000).nullable().optional(),
})

export const MoveKnowledgePageBodySchema = z.object({
  parentPageId: UuidSchema.nullable().optional(),
  position: z.number().int().nonnegative(),
})

export const RestoreKnowledgePageVersionBodySchema = z.object({
  changeComment: z.string().max(1000).nullable().optional(),
})

export const SearchKnowledgePagesBodySchema = z.object({
  query: z.string().max(500).optional(),
  labels: z.array(NonEmptyStringSchema.max(80)).max(32).optional(),
  projectId: UuidSchema.optional(),
  spaceId: UuidSchema.optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  mode: z.enum(['keyword', 'hybrid']).optional(),
})

// Ticket-bound documents + personal-space provisioning (api/src/routes/knowledge-tasks.ts).
export const MyDocsSpaceResponseSchema = z.object({
  spaceId: UuidSchema,
})

export const CreateTaskDocumentBodySchema = z.object({
  title: NonEmptyStringSchema.max(240),
  body: z.string().nullable().optional(),
})

// GET /api/knowledge-base/recent-pages — "what was written down lately in this
// project". projectId is required: this list is always about one project, never
// a silently-narrowed org-wide read.
// `limit` is clamped by the provider (default 5, ceiling 20) rather than
// rejected here: an over-large ask is a capped list, not a client error.
export const KnowledgeRecentPagesQuerySchema = z.object({
  projectId: UuidSchema,
  limit: z.coerce.number().int().positive().optional(),
})

export const KnowledgeRecentPageRecordSchema = z.object({
  id: UuidSchema,
  spaceId: UuidSchema,
  spaceName: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  kind: z.enum(['document', 'file']),
  status: KnowledgePageStatusSchema,
  updatedAt: NonEmptyStringSchema,
})

export const KnowledgeListQuerySchema = z.object({
  cursor: z.string().optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  projectId: UuidSchema.optional(),
})

// Opt-in `search.summary`: bounded, cited answer synthesized from the top
// hybrid-search chunks. `taskId`, when set, restricts results to chunks
// whose page is bound to that ticket (mirrors HybridSearchPagesInput.taskId).
export const SearchSummaryBodySchema = z.object({
  query: NonEmptyStringSchema.max(500),
  projectId: UuidSchema.optional(),
  spaceId: UuidSchema.optional(),
  taskId: UuidSchema.optional(),
  limit: z.number().int().positive().max(50).optional(),
})

export const SearchSummaryResponseSchema = z.object({
  answer: z.string().nullable(),
  citations: z.array(z.object({
    pageId: UuidSchema,
    title: NonEmptyStringSchema,
    spaceId: UuidSchema,
    quote: z.string().max(200),
  })),
  sources: z.array(z.object({
    pageId: UuidSchema,
    title: NonEmptyStringSchema,
    spaceId: UuidSchema,
    snippet: NonEmptyStringSchema,
  })),
  reason: z.literal('no_matches').optional(),
  policyChainTrace: z.array(z.string()),
})

export type CreateKnowledgePageBody = z.infer<typeof CreateKnowledgePageBodySchema>
export type CreateKnowledgeSpaceBody = z.infer<typeof CreateKnowledgeSpaceBodySchema>
export type CreateTaskDocumentBody = z.infer<typeof CreateTaskDocumentBodySchema>
export type MyDocsSpaceResponse = z.infer<typeof MyDocsSpaceResponseSchema>
export type MoveKnowledgePageBody = z.infer<typeof MoveKnowledgePageBodySchema>
export type RestoreKnowledgePageVersionBody =
  z.infer<typeof RestoreKnowledgePageVersionBodySchema>
export type SearchKnowledgePagesBody = z.infer<typeof SearchKnowledgePagesBodySchema>
export type SearchSummaryBody = z.infer<typeof SearchSummaryBodySchema>
export type SearchSummaryResponse = z.infer<typeof SearchSummaryResponseSchema>
export type UpdateKnowledgePageBody = z.infer<typeof UpdateKnowledgePageBodySchema>
export type UpdateKnowledgeSpaceBody = z.infer<typeof UpdateKnowledgeSpaceBodySchema>
