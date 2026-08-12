import { z } from 'zod'

import {
  AgentIdSchema,
  type AgentId,
  type RunId,
  RunIdSchema,
  ThreadIdSchema,
  type ThreadId,
} from './ids.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

// SSE half of the realtime catalog: chat/thread streaming only. Agent activity
// and presence belong on the WebSocket (see realtime-ws.ts). Import from
// `./realtime.js`, which is the single surface over both halves.

export type SseEventMap = {
  // `rootMessageId` is the resolved reply anchor for this run (null = the reply
  // lands top-level in the channel), so a client can place the live "thinking"
  // surface where the answer will actually appear.
  'stream.start': {
    runId: RunId
    threadId: ThreadId
    agentId: AgentId
    rootMessageId?: string | null
  }
  // `chunkId` is the durable `RunThinkingChunk` id (stringified BigInt) — set
  // when the chunk was persisted, and used by clients to dedupe live events
  // against the REST thought log.
  'stream.reasoning': { runId: RunId; content: string; chunkId?: string }
  // One tool invocation line of the thought process (`toolName: inputSummary`).
  'stream.thinking.tool': { runId: RunId; content: string; chunkId?: string }
  'stream.delta': { runId: RunId; content: string }
  // `messageId` is absent when the run answered with a reaction: the
  // terminator still fires (clearing the bubble) but there is no message.
  'stream.done': {
    runId: RunId
    messageId?: string
    agentId?: AgentId
    content?: string
    createdAt?: string
    rootMessageId?: string
  }
  'message.reaction': { messageId: string; agentId?: AgentId; userId?: string; emoji: string }
}

export const StreamStartEventSchema = z.object({
  agentId: AgentIdSchema,
  runId: RunIdSchema,
  threadId: ThreadIdSchema,
  // Resolved reply anchor: a root message id, or null for a top-level reply.
  rootMessageId: z.string().uuid().nullish(),
})
export type StreamStartEvent = z.infer<typeof StreamStartEventSchema>
export const StreamDeltaEventSchema = z.object({
  runId: RunIdSchema,
  content: z.string(),
})
export type StreamDeltaEvent = z.infer<typeof StreamDeltaEventSchema>
export const StreamReasoningEventSchema = z.object({
  runId: RunIdSchema,
  content: z.string(),
  // Durable RunThinkingChunk id (stringified BigInt) for client-side dedupe.
  chunkId: NonEmptyStringSchema.optional(),
})
export type StreamReasoningEvent = z.infer<typeof StreamReasoningEventSchema>
export const StreamThinkingToolEventSchema = z.object({
  runId: RunIdSchema,
  content: z.string(),
  chunkId: NonEmptyStringSchema.optional(),
})
export type StreamThinkingToolEvent = z.infer<typeof StreamThinkingToolEventSchema>
export const StreamDoneEventSchema = z.object({
  agentId: AgentIdSchema.optional(),
  content: z.string().optional(),
  createdAt: TimestampSchema.optional(),
  rootMessageId: z.string().uuid().optional(),
  runId: RunIdSchema,
  // Absent when the run answered with a reaction rather than a message.
  // `stream.done` is the run terminator either way: clients must always clear
  // the pending thinking bubble on it, and append a message row only when
  // `messageId` and `content` are both present.
  messageId: NonEmptyStringSchema.optional(),
})
export type StreamDoneEvent = z.infer<typeof StreamDoneEventSchema>
export const MessageReactionEventSchema = z.object({
  messageId: NonEmptyStringSchema,
  agentId: AgentIdSchema.optional(),
  userId: z.string().uuid().optional(),
  emoji: z.string(),
})
export type MessageReactionEvent = z.infer<typeof MessageReactionEventSchema>
export const SseEventNameSchema = z.enum([
  'stream.start',
  'stream.reasoning',
  'stream.thinking.tool',
  'stream.delta',
  'stream.done',
  'message.reaction',
])

export const SseEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('stream.start'),
    data: StreamStartEventSchema,
  }),
  z.object({
    event: z.literal('stream.reasoning'),
    data: StreamReasoningEventSchema,
  }),
  z.object({
    event: z.literal('stream.thinking.tool'),
    data: StreamThinkingToolEventSchema,
  }),
  z.object({
    event: z.literal('stream.delta'),
    data: StreamDeltaEventSchema,
  }),
  z.object({
    event: z.literal('stream.done'),
    data: StreamDoneEventSchema,
  }),
  z.object({
    event: z.literal('message.reaction'),
    data: MessageReactionEventSchema,
  }),
])
export type SseEvent = z.infer<typeof SseEventSchema>
