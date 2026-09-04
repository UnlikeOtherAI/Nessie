import { z } from 'zod'

import { AgentIdSchema, UserIdSchema } from './ids.js'

/**
 * Hard upper bound on the length of a single chat message body. Anything
 * larger should be sent as a file attachment instead of inline text —
 * pasted documents blow up orchestrator LLM context, cost, and latency,
 * and they make the conversation unreadable.
 */
export const CHAT_MESSAGE_MAX_CHARS = 4000

/**
 * How many attachments a single chat message may carry. The composer stages
 * uploads client-side and the message-create body caps the linked ids, so the
 * same number bounds both sides.
 */
export const MESSAGE_ATTACHMENT_LIMIT = 10

/**
 * Per-file ceiling for chat/avatar uploads (`POST /api/uploads`). Larger files
 * belong in the knowledge base, which uses the (much larger) configured
 * `NESSIE_MAX_UPLOAD_BYTES`. The composer pre-checks against this value; the
 * server's 413 stays the source of truth.
 */
export const MESSAGE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system'])
export type MessageRole = z.infer<typeof MessageRoleSchema>

/**
 * The identity selected by an agent @mention in a composer.
 *
 * Ordinary agents are addressed by `agentId`. A Personal Assistant presence
 * additionally carries its owner because several presences share one Agent
 * row inside a channel. Display text is deliberately absent: names render for
 * people, but they are not an address and need not be unique.
 */
export const AgentMentionSchema = z.object({
  type: z.literal('agent'),
  agentId: AgentIdSchema,
  principalUserId: UserIdSchema.optional(),
})
export type AgentMention = z.infer<typeof AgentMentionSchema>
