import { z } from 'zod'

/**
 * Hard upper bound on the length of a single chat message body. Anything
 * larger should be sent as a file attachment instead of inline text —
 * pasted documents blow up orchestrator LLM context, cost, and latency,
 * and they make the conversation unreadable.
 */
export const CHAT_MESSAGE_MAX_CHARS = 4000

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system'])
export type MessageRole = z.infer<typeof MessageRoleSchema>
