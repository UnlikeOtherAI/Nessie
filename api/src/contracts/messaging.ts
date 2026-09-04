import {
  AgentIdSchema,
  AgentMentionSchema,
  ChannelIdSchema,
  CHAT_MESSAGE_MAX_CHARS,
  MESSAGE_ATTACHMENT_LIMIT,
  MessageRoleSchema,
  OrganizationIdSchema,
  RunIdSchema,
  RunStatusSchema,
  ThreadIdSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema, TimestampSchema } from './shared.js'

export const MessageReactionRecordSchema = z.object({
  id: z.string().uuid(),
  messageId: z.string().uuid(),
  agentId: AgentIdSchema.nullish(),
  onBehalfOfUserId: z.string().uuid().nullish(),
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
})
export type MessageAuthor = z.infer<typeof MessageAuthorSchema>

export const ThreadMessageRecordSchema = z.object({
  id: z.string().uuid(),
  threadId: ThreadIdSchema,
  agentId: AgentIdSchema.nullish(),
  // PA-presence owner for an assistant reply in a shared channel. The client
  // renders this structural identity in the follow-up display slice.
  onBehalfOfUserId: z.string().uuid().nullish(),
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
  // How many files this message carries. Lets the feed skip the per-message
  // attachment fetch entirely for the (overwhelming) majority that carry none.
  // Absent when a producer could not determine it — clients must then fetch,
  // so an attachment is never silently hidden.
  attachmentCount: z.number().int().nonnegative().optional(),
  // Set when this message drew on sources the caller cannot reach. The row is
  // still returned — with empty content — so the client renders a placeholder
  // rather than an unexplained gap in the conversation. Absent means readable.
  restricted: z.literal(true).optional(),
  // Set when this message drew on restricted sources AND the caller can reach
  // them — so they read it normally, and they are the person who can share it.
  // The two flags are mutually exclusive by construction: being withheld means
  // failing the basis, and failing the basis means you cannot grant it.
  restrictedSources: z.literal(true).optional(),
  // Whether a standing rule may be offered for this message's sources. False
  // for private material, which is shareable one reply at a time only.
  canShareStanding: z.boolean().optional(),
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
  emailMessageId: z.string().uuid().optional(),
  kind: NonEmptyStringSchema,
  mime: NonEmptyStringSchema,
  filename: NonEmptyStringSchema,
  sizeBytes: z.union([z.bigint(), z.number(), z.string()]).transform((value) => value.toString()),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  createdAt: TimestampSchema,
  // Cheap preview served from GET /api/attachments/:id/thumbnail. Present only
  // once one exists; clients fall back to the original (or a download chip)
  // when it is absent — including for every attachment stored before this
  // existed, which is never backfilled. `thumbnailSizeBytes` is a BigInt
  // column, serialized as a decimal string like `sizeBytes`.
  hasThumbnail: z.boolean(),
  thumbnailStatus: z.enum(['pending', 'ready', 'unavailable']).optional(),
  thumbnailMime: NonEmptyStringSchema.optional(),
  thumbnailSizeBytes: z
    .union([z.bigint(), z.number(), z.string()])
    .transform((value) => value.toString())
    .optional(),
  thumbnailWidth: z.number().int().nonnegative().optional(),
  thumbnailHeight: z.number().int().nonnegative().optional(),
})
export type AttachmentRecord = z.infer<typeof AttachmentRecordSchema>

// Shape the FileService / Prisma attachment row carries when building a record.
type AttachmentRowLike = {
  id: string
  organizationId: string
  uploaderId: string | null
  messageId: string | null
  knowledgePageId: string | null
  emailMessageId?: string | null
  kind: string
  mime: string
  filename: string
  sizeBytes: bigint
  width: number | null
  height: number | null
  createdAt: Date
  thumbnailKey: string | null
  thumbnailMime: string | null
  thumbnailSizeBytes: bigint | null
  thumbnailWidth: number | null
  thumbnailHeight: number | null
  thumbnailStatus: string | null
}

// The column is a plain String (statuses are only ever written by this
// codebase); anything unrecognized is treated as "not stated" rather than
// failing the parse of an otherwise-valid attachment.
const isThumbnailStatus = (
  value: string | null,
): value is 'pending' | 'ready' | 'unavailable' =>
  value === 'pending' || value === 'ready' || value === 'unavailable'

// Single mapper from a stored attachment row to the wire record, so every route
// serializes attachments identically (and handles the BigInt → string cast).
export const toAttachmentRecord = (row: AttachmentRowLike): AttachmentRecord =>
  AttachmentRecordSchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    uploaderId: row.uploaderId ?? undefined,
    messageId: row.messageId ?? undefined,
    knowledgePageId: row.knowledgePageId ?? undefined,
    emailMessageId: row.emailMessageId ?? undefined,
    kind: row.kind,
    mime: row.mime,
    filename: row.filename,
    sizeBytes: row.sizeBytes,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    createdAt: row.createdAt.toISOString(),
    // The storage key itself is never exposed — only whether bytes exist at the
    // thumbnail endpoint, and the geometry needed to reserve the right box.
    hasThumbnail: row.thumbnailKey !== null,
    thumbnailStatus: isThumbnailStatus(row.thumbnailStatus) ? row.thumbnailStatus : undefined,
    thumbnailMime: row.thumbnailMime ?? undefined,
    thumbnailSizeBytes: row.thumbnailSizeBytes ?? undefined,
    thumbnailWidth: row.thumbnailWidth ?? undefined,
    thumbnailHeight: row.thumbnailHeight ?? undefined,
  })

// ─── Agent thought process (thinking bubbles) ──────────────────────────────
// The durable counterpart of the live `stream.reasoning` /
// `stream.thinking.tool` SSE events. Chunk ids are BigInt columns, serialized
// as decimal strings (same rule as `Attachment.sizeBytes`).
export const RunThinkingEntrySchema = z.object({
  id: NonEmptyStringSchema,
  kind: z.enum(['reasoning', 'tool']),
  content: z.string(),
  createdAt: TimestampSchema,
})
export type RunThinkingEntry = z.infer<typeof RunThinkingEntrySchema>

export const RunThinkingLogSchema = z.object({
  run: z.object({
    id: RunIdSchema,
    agentId: AgentIdSchema,
    status: RunStatusSchema,
    // Resolved reply anchor: null when the reply lands top-level.
    rootMessageId: z.string().uuid().nullable(),
  }),
  entries: RunThinkingEntrySchema.array(),
  // True when older entries were elided from the head of the log.
  truncated: z.boolean(),
})
export type RunThinkingLog = z.infer<typeof RunThinkingLogSchema>

// Mid-run joiner bootstrap: the live runs of a thread with their tail log, so a
// client that missed the (never-replayed) SSE stream can still render a bubble.
export const ThreadThinkingSchema = z.object({
  runs: z.array(z.object({
    runId: RunIdSchema,
    agentId: AgentIdSchema,
    rootMessageId: z.string().uuid().nullable(),
    startedAt: TimestampSchema.nullable(),
    entries: RunThinkingEntrySchema.array(),
    lastChunkId: NonEmptyStringSchema.nullable(),
  })),
})
export type ThreadThinking = z.infer<typeof ThreadThinkingSchema>

export const CreateThreadMessageBodySchema = z
  .object({
    // Optional: an attachment-only post (drag-drop / paperclip with no text) is
    // a valid message. The refine below keeps "neither text nor files" out.
    content: z.string().max(CHAT_MESSAGE_MAX_CHARS).optional(),
    // Attachments are uploaded first via POST /api/uploads; the returned ids are
    // linked to the message after it is created (uploader-scoped, see the route).
    attachmentIds: z.array(z.string().uuid()).max(MESSAGE_ATTACHMENT_LIMIT).optional(),
    // Reply threads (#233): when set, the message is a reply under this root
    // (validated to live in the same container thread and to be a root itself).
    rootMessageId: z.string().uuid().optional(),
    // Slack-parity "Also send to #channel": posts an additional top-level copy
    // referencing the reply thread.
    alsoSendToChannel: z.boolean().optional(),
    // Every composer-selected agent is addressed through this id-keyed entity,
    // never by a display-name match against content.
    agentMentions: AgentMentionSchema.array().optional(),
    // Idempotency key minted by the client for one unsent draft. A retried send
    // carrying the same key resolves to the message the first attempt created
    // rather than posting a second copy. Also accepted as an `Idempotency-Key`
    // request header; the body field wins when both are present.
    clientMessageId: z.string().min(1).max(200).optional(),
  })
  .refine(
    (body) =>
      (body.content?.trim().length ?? 0) > 0 || (body.attachmentIds?.length ?? 0) > 0,
    { message: 'A message needs content or at least one attachment' },
  )

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

// Omit rootMessageId when the visible surface is the channel feed. Supplying a
// root acknowledges only that one reply conversation.
export const MarkThreadReadBodySchema = z.object({
  rootMessageId: z.string().uuid().optional(),
  // The client only supplies a message it rendered through the disclosure
  // predicate. This is the exact read cursor for a reply conversation.
  lastReadMessageId: z.string().uuid().optional(),
})
export type MarkThreadReadBody = z.infer<typeof MarkThreadReadBodySchema>

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
