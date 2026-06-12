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
export const AttachmentRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  uploaderId: z.string().uuid().optional(),
  messageId: z.string().uuid().optional(),
  kind: NonEmptyStringSchema,
  mime: NonEmptyStringSchema,
  filename: NonEmptyStringSchema,
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  createdAt: TimestampSchema,
})
export type AttachmentRecord = z.infer<typeof AttachmentRecordSchema>

export const CreateThreadMessageBodySchema = z.object({
  content: z.string().min(1).max(CHAT_MESSAGE_MAX_CHARS),
  // Attachments are uploaded first via POST /api/uploads; the returned ids are
  // linked to the message after it is created.
  attachmentIds: z.array(z.string().uuid()).optional(),
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
})
export type ListThreadMessagesQuery = z.infer<typeof ListThreadMessagesQuerySchema>

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
