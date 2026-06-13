import { z } from 'zod'
import { KnowledgeAuthorTypeSchema } from './knowledge-base.js'

const NonEmptyStringSchema = z.string().trim().min(1)
const UuidSchema = z.string().uuid()
const BodySchema = z.string().trim().min(1).max(10_000)

export const AnnotationKindSchema = z.enum(['comment', 'note'])
export const AnnotationStateSchema = z.enum(['open', 'resolved'])

export const TextQuoteAnchorSchema = z.object({
  quote: z.string().min(1).max(2000),
  prefix: z.string().max(400),
  suffix: z.string().max(400),
  startOffset: z.number().int().nonnegative(),
})

export const CreateCommentBodySchema = z.object({ body: BodySchema })

export const CreateNoteBodySchema = z.object({
  body: BodySchema,
  anchor: TextQuoteAnchorSchema,
  anchorVersionId: UuidSchema.nullable().optional(),
})

export const CreateReplyBodySchema = z.object({ body: BodySchema })
export const EditAnnotationBodySchema = z.object({ body: BodySchema })
export const ToggleReactionBodySchema = z.object({ emoji: z.string().trim().min(1).max(64) })

export const AnnotationListQuerySchema = z.object({
  kind: AnnotationKindSchema.optional(),
})

const AnnotationBaseSchema = z.object({
  id: UuidSchema,
  pageId: UuidSchema,
  spaceId: UuidSchema,
  kind: AnnotationKindSchema,
  state: AnnotationStateSchema,
  parentId: UuidSchema.nullable(),
  body: z.string(),
  authorType: KnowledgeAuthorTypeSchema,
  authorId: NonEmptyStringSchema,
  delegatedByAgentId: UuidSchema.nullable(),
  anchor: TextQuoteAnchorSchema.nullable(),
  anchorVersionId: UuidSchema.nullable(),
  orphaned: z.boolean(),
  resolvedAt: z.string().nullable(),
  editedAt: z.string().nullable(),
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
})

export const AnnotationRecordSchema = AnnotationBaseSchema.extend({
  replies: z.array(AnnotationBaseSchema),
})

export type CreateCommentBody = z.infer<typeof CreateCommentBodySchema>
export type CreateNoteBody = z.infer<typeof CreateNoteBodySchema>
export type CreateReplyBody = z.infer<typeof CreateReplyBodySchema>
export type EditAnnotationBody = z.infer<typeof EditAnnotationBodySchema>
export type AnnotationRecordContract = z.infer<typeof AnnotationRecordSchema>
