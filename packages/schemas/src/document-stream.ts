import { z } from 'zod'

import { DocumentStreamErrorReasonSchema } from './realtime-sse.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

// REST contract for live document composition. Shared so the API validates and
// the admin consumes one definition rather than two drifting copies.

export const DOCUMENT_STREAM_STATUSES = [
  'streaming',
  'saving',
  'saved',
  'failed',
  'cancelled',
  'superseded',
] as const
export const DocumentStreamStatusSchema = z.enum(DOCUMENT_STREAM_STATUSES)
export type DocumentStreamStatus = (typeof DOCUMENT_STREAM_STATUSES)[number]

export const DocumentStreamTargetSchema = z.object({
  parentPageId: z.string().uuid().nullable(),
  parentTitle: z.string().nullable(),
  spaceId: z.string().uuid().nullable(),
  spaceName: z.string().nullable(),
})
export type DocumentStreamTarget = z.infer<typeof DocumentStreamTargetSchema>

export const DocumentStreamSummarySchema = z.object({
  agentId: z.string().uuid(),
  chars: z.number().int().nonnegative(),
  errorReason: DocumentStreamErrorReasonSchema.nullable(),
  pageId: z.string().uuid().nullable(),
  published: z.boolean(),
  runId: z.string().uuid(),
  sessionId: z.string().uuid(),
  startedAt: TimestampSchema,
  status: DocumentStreamStatusSchema,
  target: DocumentStreamTargetSchema,
  title: z.string().nullable(),
  versionNumber: z.number().int().positive().nullable(),
})
export type DocumentStreamSummary = z.infer<typeof DocumentStreamSummarySchema>

export const DocumentStreamListResponseSchema = z.object({
  sessions: z.array(DocumentStreamSummarySchema),
})
export type DocumentStreamListResponse = z.infer<typeof DocumentStreamListResponseSchema>

/**
 * Bootstrap watermark. `offset` is the length of `markdown` in UTF-16 code
 * units — the same unit `stream.document.delta` offsets use — so a client can
 * merge buffered live deltas against it without any encoding step, and
 * `lastSeq` tells it which delta sequence that watermark corresponds to.
 */
export const DocumentStreamDetailResponseSchema = z.object({
  lastSeq: z.number().int().nonnegative(),
  markdown: z.string(),
  offset: z.number().int().nonnegative(),
  session: DocumentStreamSummarySchema,
})
export type DocumentStreamDetailResponse = z.infer<typeof DocumentStreamDetailResponseSchema>

export const DocumentStreamRetargetBodySchema = z.object({
  parentPageId: z.string().uuid().nullish(),
  spaceId: z.string().uuid(),
})
export type DocumentStreamRetargetBody = z.infer<typeof DocumentStreamRetargetBodySchema>

export const DocumentStreamRetargetResponseSchema = z.object({
  moved: z.boolean(),
  session: DocumentStreamSummarySchema,
})
export type DocumentStreamRetargetResponse = z.infer<
  typeof DocumentStreamRetargetResponseSchema
>

/**
 * Server-authored reference stamped on the run's final chat message so a saved
 * document stays reachable after the popup closes — the durable doorway the
 * popup's own "Open document" button cannot provide (`metadata.runStop` is the
 * precedent). Never written from model output.
 */
export const DocumentRefMetadataSchema = z.object({
  pageId: z.string().uuid(),
  published: z.boolean(),
  sessionId: z.string().uuid(),
  spaceId: z.string().uuid(),
  title: NonEmptyStringSchema,
})
export type DocumentRefMetadata = z.infer<typeof DocumentRefMetadataSchema>
