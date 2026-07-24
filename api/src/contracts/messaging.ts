import {
  AgentIdSchema,
  ChannelIdSchema,
  CHAT_MESSAGE_MAX_CHARS,
  MessageRoleSchema,
  OrganizationIdSchema,
  ThreadIdSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema, TimestampSchema } from './shared.js'

export const MessageReactionRecordSchema = z.object({
  id: z.string().uuid(),
  messageId: z.string().uuid(),
  agentId: AgentIdSchema.nullish(),
  userId: z.string().uuid().nullish(),
  emoji: z.string(),
  createdAt: TimestampSchema,
})
export type MessageReactionRecord = z.infer<typeof MessageReactionRecordSchema>

// Embedded author identity for a user-authored message, so the feed can render
// the real sender's name + avatar without a separate lookup. Absent for
// assistant/system messages (resolved via agentMap / a literal label instead).
export const MessageAuthorSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  avatarUrl: z.string().nullish(),
  avatarAttachmentId: z.string().uuid().nullish(),
  gravatarUrl: z.string().nullish(),
})
export type MessageAuthor = z.infer<typeof MessageAuthorSchema>

export const ThreadMessageRecordSchema = z.object({
  id: z.string().uuid(),
  threadId: ThreadIdSchema,
  agentId: AgentIdSchema.nullish(),
  userId: z.string().uuid().nullish(),
  author: MessageAuthorSchema.nullish(),
  role: MessageRoleSchema,
  content: z.string(),
  createdAt: TimestampSchema,
  editedAt: TimestampSchema.nullish(),
  deletedAt: TimestampSchema.nullish(),
  // Message-level reply threads (#233): set on replies (id of the top-level
  // root they belong to); the metadata fields are materialized on roots.
  rootMessageId: z.string().uuid().nullish(),
  replyCount: z.number().int().nonnegative().optional(),
  lastReplyAt: TimestampSchema.nullish(),
  replyParticipantIds: z.array(z.string().uuid()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  reactions: MessageReactionRecordSchema.array().optional(),
})
export type ThreadMessageRecord = z.infer<typeof ThreadMessageRecordSchema>

export const ThreadRecordSchema = z.object({
  id: ThreadIdSchema,
  channelId: ChannelIdSchema,
  title: z.string(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
})
export type ThreadRecord = z.infer<typeof ThreadRecordSchema>

// ─── File uploads / attachments (Slack-parity files slice) ──────────────────
// sizeBytes is a BigInt column (uploads up to 5 GB), serialized as a decimal
// string so it survives JSON without precision loss.
export const AttachmentRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  uploaderId: z.string().uuid().optional(),
  messageId: z.string().uuid().optional(),
  knowledgePageId: z.string().uuid().optional(),
  kind: NonEmptyStringSchema,
  mime: NonEmptyStringSchema,
  filename: NonEmptyStringSchema,
  sizeBytes: z.union([z.bigint(), z.number(), z.string()]).transform((value) => value.toString()),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  createdAt: TimestampSchema,
})
export type AttachmentRecord = z.infer<typeof AttachmentRecordSchema>

// Shape the FileService / Prisma attachment row carries when building a record.
type AttachmentRowLike = {
  id: string
  organizationId: string
  uploaderId: string | null
  messageId: string | null
  knowledgePageId: string | null
  kind: string
  mime: string
  filename: string
  sizeBytes: bigint
  width: number | null
  height: number | null
  createdAt: Date
}

// Single mapper from a stored attachment row to the wire record, so every route
// serializes attachments identically (and handles the BigInt → string cast).
export const toAttachmentRecord = (row: AttachmentRowLike): AttachmentRecord =>
  AttachmentRecordSchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    uploaderId: row.uploaderId ?? undefined,
    messageId: row.messageId ?? undefined,
    knowledgePageId: row.knowledgePageId ?? undefined,
    kind: row.kind,
    mime: row.mime,
    filename: row.filename,
    sizeBytes: row.sizeBytes,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    createdAt: row.createdAt.toISOString(),
  })

export const CreateThreadMessageBodySchema = z.object({
  content: z.string().min(1).max(CHAT_MESSAGE_MAX_CHARS),
  // Attachments are uploaded first via POST /api/uploads; the returned ids are
  // linked to the message after it is created.
  attachmentIds: z.array(z.string().uuid()).optional(),
  // Reply threads (#233): when set, the message is a reply under this root
  // (validated to live in the same container thread and to be a root itself).
  rootMessageId: z.string().uuid().optional(),
  // Slack-parity "Also send to #channel": posts an additional top-level copy
  // referencing the reply thread.
  alsoSendToChannel: z.boolean().optional(),
})

// ─── sp-messaging slice: edit, delete, search ──────────────────────────────
export const UpdateThreadMessageBodySchema = z.object({
  content: z.string().min(1).max(CHAT_MESSAGE_MAX_CHARS),
})
export type UpdateThreadMessageBody = z.infer<typeof UpdateThreadMessageBodySchema>

export const ListThreadMessagesQuerySchema = z.object({
  before: z.string().min(1).optional(),
  after: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  senderId: z.string().uuid().optional(),
  // When set, lists replies of that root message; otherwise lists top-level
  // posts (roots) only.
  rootMessageId: z.string().uuid().optional(),
})
export type ListThreadMessagesQuery = z.infer<typeof ListThreadMessagesQuerySchema>

// Explicit follow/unfollow of a reply thread (#233).
export const SetMessageThreadFollowBodySchema = z.object({
  following: z.boolean(),
})
export type SetMessageThreadFollowBody = z.infer<typeof SetMessageThreadFollowBodySchema>

export const MessageSearchResultSchema = z.object({
  id: z.string().uuid(),
  threadId: ThreadIdSchema,
  channelId: ChannelIdSchema,
  channelLabel: z.string(),
  snippet: z.string(),
  createdAt: TimestampSchema,
  authorName: z.string(),
  agentId: AgentIdSchema.nullish(),
  userId: z.string().uuid().nullish(),
})
export type MessageSearchResult = z.infer<typeof MessageSearchResultSchema>

export const MessageSearchQuerySchema = z.object({
  query: z.string().min(1),
  channelId: ChannelIdSchema.optional(),
  senderId: z.string().uuid().optional(),
  before: z.string().min(1).optional(),
  after: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})
export type MessageSearchQuery = z.infer<typeof MessageSearchQuerySchema>
