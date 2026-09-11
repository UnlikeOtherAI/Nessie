import { z } from 'zod'

import { AgentIdSchema, ChannelIdSchema, ThreadIdSchema } from './ids.js'

/**
 * `Message.metadata.conversationRef` — the doorway into an agent conversation.
 *
 * The `agentHandoffDoorway` pattern generalised: a pointer on an ordinary
 * message, rendered as a card. **Server-written only**, from rows the writer
 * just read or wrote — never from model text, exactly as `documentRef` and
 * `agentHandoffDoorway` are.
 *
 * It deliberately carries no status. The card is *live*: it renders whatever
 * `GET /api/threads/:threadId/conversation` says right now, so a status stored
 * here would be a snapshot that lies within a minute.
 *
 * Spec: docs/plans/2026-09-08-agent-conversations.md § "The doorway".
 */
export const CONVERSATION_REF_SCHEMA_VERSION = 1

export const ConversationRefMetadataSchema = z.object({
  schemaVersion: z.literal(CONVERSATION_REF_SCHEMA_VERSION),
  threadId: ThreadIdSchema,
  channelId: ChannelIdSchema,
  agentId: AgentIdSchema,
}).strict()
export type ConversationRefMetadata = z.infer<typeof ConversationRefMetadataSchema>

/**
 * Read a doorway off a message's metadata, or nothing.
 *
 * Safe-parse, never throw: message metadata is a `Json` column that predates
 * this schema and a malformed or foreign shape must render nothing rather than
 * break the feed.
 */
export const readConversationRef = (
  metadata: unknown,
): ConversationRefMetadata | null => {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return null
  }
  const candidate = (metadata as { conversationRef?: unknown }).conversationRef
  if (candidate === undefined) return null
  const parsed = ConversationRefMetadataSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}
