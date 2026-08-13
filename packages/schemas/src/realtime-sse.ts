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

// Why a document stream ended without a saved file. `superseded` is written
// only by the recorder's per-invocation bracket (a retried or re-issued
// inference attempt replaces an in-flight session).
export const DOCUMENT_STREAM_ERROR_REASONS = [
  'cancelled',
  'run_failed',
  'save_failed',
  'budget_stopped',
  'invalid_args',
  'truncated',
  'superseded',
] as const
export const DocumentStreamErrorReasonSchema = z.enum(DOCUMENT_STREAM_ERROR_REASONS)
export type DocumentStreamErrorReason = (typeof DOCUMENT_STREAM_ERROR_REASONS)[number]

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
  // Live document composition (`kb_document_compose`). `stream.document.delta`
  // is EPHEMERAL — notify-only, never a `thread_stream_events` row — because a
  // per-provider-chunk durable insert is the write-amplification mistake
  // `stream.delta` already makes. Reconnecting clients repair from the
  // document-stream bootstrap route instead. The other five are durable and
  // replay, so a reconnect still learns a session started/ended.
  'stream.document.start': {
    runId: RunId
    sessionId: string
    threadId: ThreadId
    agentId: AgentId
    toolCallId: string
    // `edit` means the session already has content — the document being
    // changed — which the client must load before any delta makes sense.
    // `compose` starts from nothing, so it needs no fetch.
    mode: 'compose' | 'edit'
  }
  'stream.document.meta': {
    runId: RunId
    sessionId: string
    title?: string
    spaceId?: string
    spaceName?: string
    parentPageId?: string
    parentTitle?: string
  }
  // `offset` is the decoded-markdown offset (UTF-16 code units, the unit JS
  // strings count in) before this fragment; `seq` is a per-session counter
  // assigned at publish time so merges/splits cannot fabricate gaps.
  'stream.document.delta': {
    runId: RunId
    sessionId: string
    seq: number
    offset: number
    content: string
  }
  'stream.document.done': {
    runId: RunId
    sessionId: string
    pageId: string
    versionNumber: number
    title: string
    spaceId: string
    spaceName?: string
    chars: number
    published: boolean
  }
  'stream.document.error': {
    runId: RunId
    sessionId: string
    reason: DocumentStreamErrorReason
  }
  'stream.document.target': {
    runId: RunId
    sessionId: string
    spaceId: string
    spaceName?: string
    parentPageId?: string
    parentTitle?: string
  }
  // An edit begins: `removeLength` code units at `offset` are being replaced,
  // and the write cursor moves there. Sent before the replacement text streams,
  // so a viewer can move to the edit site before there is anything to show. A
  // freshly composed document is the degenerate case — one edit at offset 0
  // removing nothing.
  'stream.document.edit': {
    runId: RunId
    sessionId: string
    editIndex: number
    offset: number
    removeLength: number
  }
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
const SessionIdSchema = z.string().uuid()

export const StreamDocumentStartEventSchema = z.object({
  agentId: AgentIdSchema,
  mode: z.enum(['compose', 'edit']).default('compose'),
  runId: RunIdSchema,
  sessionId: SessionIdSchema,
  threadId: ThreadIdSchema,
  toolCallId: NonEmptyStringSchema,
})
export type StreamDocumentStartEvent = z.infer<typeof StreamDocumentStartEventSchema>

export const StreamDocumentMetaEventSchema = z.object({
  parentPageId: z.string().uuid().optional(),
  parentTitle: z.string().optional(),
  runId: RunIdSchema,
  sessionId: SessionIdSchema,
  spaceId: z.string().uuid().optional(),
  spaceName: z.string().optional(),
  title: z.string().optional(),
})
export type StreamDocumentMetaEvent = z.infer<typeof StreamDocumentMetaEventSchema>

export const StreamDocumentDeltaEventSchema = z.object({
  content: z.string(),
  offset: z.number().int().nonnegative(),
  runId: RunIdSchema,
  seq: z.number().int().nonnegative(),
  sessionId: SessionIdSchema,
})
export type StreamDocumentDeltaEvent = z.infer<typeof StreamDocumentDeltaEventSchema>

export const StreamDocumentDoneEventSchema = z.object({
  chars: z.number().int().nonnegative(),
  pageId: z.string().uuid(),
  published: z.boolean(),
  runId: RunIdSchema,
  sessionId: SessionIdSchema,
  spaceId: z.string().uuid(),
  spaceName: z.string().optional(),
  title: NonEmptyStringSchema,
  versionNumber: z.number().int().positive(),
})
export type StreamDocumentDoneEvent = z.infer<typeof StreamDocumentDoneEventSchema>

export const StreamDocumentErrorEventSchema = z.object({
  reason: DocumentStreamErrorReasonSchema,
  runId: RunIdSchema,
  sessionId: SessionIdSchema,
})
export type StreamDocumentErrorEvent = z.infer<typeof StreamDocumentErrorEventSchema>

export const StreamDocumentTargetEventSchema = z.object({
  parentPageId: z.string().uuid().optional(),
  parentTitle: z.string().optional(),
  runId: RunIdSchema,
  sessionId: SessionIdSchema,
  spaceId: z.string().uuid(),
  spaceName: z.string().optional(),
})
export type StreamDocumentTargetEvent = z.infer<typeof StreamDocumentTargetEventSchema>

export const StreamDocumentEditEventSchema = z.object({
  editIndex: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  removeLength: z.number().int().nonnegative(),
  runId: RunIdSchema,
  sessionId: SessionIdSchema,
})
export type StreamDocumentEditEvent = z.infer<typeof StreamDocumentEditEventSchema>

export const SseEventNameSchema = z.enum([
  'stream.start',
  'stream.reasoning',
  'stream.thinking.tool',
  'stream.delta',
  'stream.done',
  'message.reaction',
  'stream.document.start',
  'stream.document.meta',
  'stream.document.delta',
  'stream.document.done',
  'stream.document.error',
  'stream.document.target',
  'stream.document.edit',
])

/**
 * Events published notify-only, with no durable `thread_stream_events` row.
 *
 * The hub must treat these specially: no SSE `id:` line (an absent sequence
 * would otherwise set the client's Last-Event-ID to the string "undefined"),
 * no `connection.lastSequence` assignment, and dropped rather than buffered
 * during connect-hydration — a hydrating client bootstraps over REST, which
 * covers the gap by construction.
 */
export const EPHEMERAL_SSE_EVENTS: ReadonlySet<SseEvent['event']> = new Set([
  'stream.document.delta',
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
  z.object({
    event: z.literal('stream.document.start'),
    data: StreamDocumentStartEventSchema,
  }),
  z.object({
    event: z.literal('stream.document.meta'),
    data: StreamDocumentMetaEventSchema,
  }),
  z.object({
    event: z.literal('stream.document.delta'),
    data: StreamDocumentDeltaEventSchema,
  }),
  z.object({
    event: z.literal('stream.document.done'),
    data: StreamDocumentDoneEventSchema,
  }),
  z.object({
    event: z.literal('stream.document.error'),
    data: StreamDocumentErrorEventSchema,
  }),
  z.object({
    event: z.literal('stream.document.target'),
    data: StreamDocumentTargetEventSchema,
  }),
  z.object({
    event: z.literal('stream.document.edit'),
    data: StreamDocumentEditEventSchema,
  }),
])
export type SseEvent = z.infer<typeof SseEventSchema>
