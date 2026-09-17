import { z } from 'zod'

import {
  SpreadsheetAppliedBatchSchema,
  SpreadsheetPresenceEventSchema,
} from './spreadsheet.js'

// The per-document live lane's event vocabulary. Nothing durable rides it: a
// client that missed an event repairs over REST (`…/spreadsheet/ops?afterSeq=`
// for `sheet.ops`, a re-bootstrap for the rest), which is why every payload
// here is bounded and none of them is replayable.
//
// docs/plans/2026-09-15-spreadsheets-ironcalc/realtime-and-presence.md

export const DOCUMENT_SSE_EVENTS = [
  'sheet.ops',
  'sheet.presence',
  'sheet.presence.leave',
  'sheet.presence.request',
  'sheet.snapshot',
  'sheet.closed',
] as const

export const DocumentSseEventNameSchema = z.enum(DOCUMENT_SSE_EVENTS)
export type DocumentSseEventName = (typeof DOCUMENT_SSE_EVENTS)[number]

export const SpreadsheetPresenceLeaveSchema = z.object({
  pageId: z.string().uuid(),
  clientId: z.string().min(1).max(64),
})

export const SpreadsheetPresenceRequestSchema = z.object({
  pageId: z.string().uuid(),
})

export const SpreadsheetSnapshotEventSchema = z.object({
  pageId: z.string().uuid(),
  versionId: z.string().uuid(),
  seq: z.number().int().min(0),
})

export const SPREADSHEET_CLOSED_REASONS = ['archived', 'deleted', 'engine-migrating'] as const

export const SpreadsheetClosedEventSchema = z.object({
  pageId: z.string().uuid(),
  reason: z.enum(SPREADSHEET_CLOSED_REASONS),
})

/**
 * One validator for every event the lane carries, so a payload that cannot be
 * parsed is refused at the publish door rather than at each of the readers.
 * The admin's SSE reader validates every frame against the same union and
 * drops an event name it has never heard of.
 */
export const DocumentSseEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('sheet.ops'), data: SpreadsheetAppliedBatchSchema }),
  z.object({ event: z.literal('sheet.presence'), data: SpreadsheetPresenceEventSchema }),
  z.object({ event: z.literal('sheet.presence.leave'), data: SpreadsheetPresenceLeaveSchema }),
  z.object({ event: z.literal('sheet.presence.request'), data: SpreadsheetPresenceRequestSchema }),
  z.object({ event: z.literal('sheet.snapshot'), data: SpreadsheetSnapshotEventSchema }),
  z.object({ event: z.literal('sheet.closed'), data: SpreadsheetClosedEventSchema }),
])
export type DocumentSseEvent = z.infer<typeof DocumentSseEventSchema>
