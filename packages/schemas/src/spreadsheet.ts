import { z } from 'zod'

// The shared contract every spreadsheet surface codes against: the admin pane,
// the API write door, the worker's builtin tools and the MCP server. IronCalc
// addresses cells 1-based (row 1, column 1 = A) and sheets by index; this
// contract keeps that addressing and the A1 helpers translate at the edges.
//
// docs/plans/2026-09-15-spreadsheets-ironcalc/storage-and-concurrency.md

/** The one pinned engine pair: @ironcalc/wasm 0.8.4 + @ironcalc/nodejs 0.8.3. */
export const SPREADSHEET_ENGINE_VERSION = '0.8.3'

export const SPREADSHEET_LIMITS = {
  maxSheets: 50,
  maxCellsPerRead: 10_000,
  maxCellsPerWrite: 10_000,
  maxBatchBytes: 4_000_000,
  maxCellTextChars: 32_000,
  maxDraftChars: 256,
  maxPresenceFramesPerSecond: 10,
  opsCatchUpPageSize: 200,
  compactEveryBatches: 200,
  compactAfterIdleMs: 300_000,
  opsRetentionDays: 30,
  hotSnapshotEveryBatches: 25,
  modelCacheMaxBytes: 256 * 1024 * 1024,
  modelCacheIdleMs: 600_000,
  destructiveRowsThreshold: 100,
  destructiveCellsThreshold: 1_000,
  maxTouchedRectangles: 64,
  maxIntentsPerBatch: 200,
} as const

export const SPREADSHEET_MAX_ROWS = 1_048_576
export const SPREADSHEET_MAX_COLUMNS = 16_384

// ---------------------------------------------------------------- A1 helpers

const COLUMN_LABEL = /^[A-Z]{1,3}$/

export function columnIndexToLabel(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > SPREADSHEET_MAX_COLUMNS) {
    throw new Error(`column index out of range: ${index}`)
  }
  let label = ''
  let remaining = index
  while (remaining > 0) {
    const rest = (remaining - 1) % 26
    label = String.fromCharCode(65 + rest) + label
    remaining = Math.floor((remaining - 1) / 26)
  }
  return label
}

export function columnLabelToIndex(label: string): number {
  const upper = label.toUpperCase()
  if (!COLUMN_LABEL.test(upper)) throw new Error(`not a column label: ${label}`)
  let index = 0
  for (const char of upper) index = index * 26 + (char.charCodeAt(0) - 64)
  if (index > SPREADSHEET_MAX_COLUMNS) throw new Error(`column out of range: ${label}`)
  return index
}

/** `{ r0, c0, r1, c1 }`, 1-based and inclusive, normalised so r0 <= r1. */
export const SpreadsheetSelectionSchema = z
  .object({
    r0: z.number().int().min(1).max(SPREADSHEET_MAX_ROWS),
    c0: z.number().int().min(1).max(SPREADSHEET_MAX_COLUMNS),
    r1: z.number().int().min(1).max(SPREADSHEET_MAX_ROWS),
    c1: z.number().int().min(1).max(SPREADSHEET_MAX_COLUMNS),
  })
  .refine((r) => r.r0 <= r.r1 && r.c0 <= r.c1, {
    message: 'selection must be normalised (r0 <= r1, c0 <= c1)',
  })
export type SpreadsheetSelection = z.infer<typeof SpreadsheetSelectionSchema>

const A1_CELL = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/

export const A1Schema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}(:\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6})?$/, {
    message: 'expected an A1 cell or range, e.g. B2 or B2:D40',
  })

/** `"B2"` or `"B2:D40"` → a normalised selection. Sheet prefixes are not accepted;
 *  every tool and route takes the sheet separately so a range can never disagree
 *  with the sheet it was addressed to. */
export function parseA1Range(a1: string): SpreadsheetSelection {
  const [start, end] = A1Schema.parse(a1).split(':')
  const first = start ? A1_CELL.exec(start) : null
  if (!first?.[1] || !first[2]) throw new Error(`not an A1 reference: ${a1}`)
  const last = end ? A1_CELL.exec(end) : first
  if (!last?.[1] || !last[2]) throw new Error(`not an A1 reference: ${a1}`)
  const rows = [Number(first[2]), Number(last[2])]
  const cols = [columnLabelToIndex(first[1]), columnLabelToIndex(last[1])]
  const selection = {
    r0: Math.min(...rows),
    c0: Math.min(...cols),
    r1: Math.max(...rows),
    c1: Math.max(...cols),
  }
  return SpreadsheetSelectionSchema.parse(selection)
}

export function formatA1Range(selection: SpreadsheetSelection): string {
  const { r0, c0, r1, c1 } = SpreadsheetSelectionSchema.parse(selection)
  const start = `${columnIndexToLabel(c0)}${r0}`
  return r0 === r1 && c0 === c1 ? start : `${start}:${columnIndexToLabel(c1)}${r1}`
}

export function selectionCellCount(selection: SpreadsheetSelection): number {
  return (selection.r1 - selection.r0 + 1) * (selection.c1 - selection.c0 + 1)
}

// ------------------------------------------------------------------- actors

export const PRESENCE_PALETTE = [
  '#2563eb',
  '#db2777',
  '#16a34a',
  '#ea580c',
  '#7c3aed',
  '#0891b2',
  '#ca8a04',
  '#dc2626',
] as const

/** Stable per actor so a person keeps their colour across sessions and replicas. */
export function presenceColorFor(actorId: string): string {
  let hash = 0
  for (let i = 0; i < actorId.length; i++) hash = (hash * 31 + actorId.charCodeAt(i)) >>> 0
  return PRESENCE_PALETTE[hash % PRESENCE_PALETTE.length]!
}

export const SpreadsheetActorSchema = z.object({
  type: z.enum(['user', 'agent']),
  id: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  agentId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
})
export type SpreadsheetActor = z.infer<typeof SpreadsheetActorSchema>

// ------------------------------------------------------------------- batches

export const SPREADSHEET_STRUCTURAL_KINDS = [
  'insertRows',
  'deleteRows',
  'insertColumns',
  'deleteColumns',
  'moveRows',
  'moveColumns',
  'sort',
  'addSheet',
  'deleteSheet',
  'renameSheet',
  'moveSheet',
] as const
export const SpreadsheetStructuralKindSchema = z.enum(SPREADSHEET_STRUCTURAL_KINDS)
export type SpreadsheetStructuralKind = (typeof SPREADSHEET_STRUCTURAL_KINDS)[number]

export const SpreadsheetRectangleSchema = z.object({
  sheet: z.number().int().min(0),
  r0: z.number().int().min(1),
  c0: z.number().int().min(1),
  r1: z.number().int().min(1),
  c1: z.number().int().min(1),
})
export type SpreadsheetRectangle = z.infer<typeof SpreadsheetRectangleSchema>

/** What the browser recorded itself doing, so a refused batch can be replayed
 *  against a moved grid. Server-built batches carry no intents. */
export const SpreadsheetIntentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('setUserInput'),
    sheet: z.number().int().min(0),
    row: z.number().int().min(1),
    column: z.number().int().min(1),
    value: z.string().max(SPREADSHEET_LIMITS.maxCellTextChars),
  }),
  z.object({
    kind: z.literal('updateRangeStyle'),
    sheet: z.number().int().min(0),
    range: SpreadsheetSelectionSchema,
    stylePath: z.string().min(1).max(64),
    value: z.string().max(200),
  }),
  z.object({
    kind: z.enum(['rangeClearAll', 'rangeClearContents', 'rangeClearFormatting']),
    sheet: z.number().int().min(0),
    range: SpreadsheetSelectionSchema,
  }),
  z.object({
    kind: z.enum(['insertRows', 'deleteRows']),
    sheet: z.number().int().min(0),
    row: z.number().int().min(1),
    count: z.number().int().min(1).max(10_000),
  }),
  z.object({
    kind: z.enum(['insertColumns', 'deleteColumns']),
    sheet: z.number().int().min(0),
    column: z.number().int().min(1),
    count: z.number().int().min(1).max(10_000),
  }),
  z.object({
    kind: z.enum(['moveRows', 'moveColumns']),
    sheet: z.number().int().min(0),
    start: z.number().int().min(1),
    count: z.number().int().min(1).max(10_000),
    delta: z.number().int(),
  }),
  z.object({
    kind: z.enum(['setRowsHidden', 'setColumnsHidden']),
    sheet: z.number().int().min(0),
    start: z.number().int().min(1),
    end: z.number().int().min(1),
    hidden: z.boolean(),
  }),
  z.object({
    kind: z.enum(['setRowsHeight', 'setColumnsWidth']),
    sheet: z.number().int().min(0),
    start: z.number().int().min(1),
    end: z.number().int().min(1),
    size: z.number().min(0),
  }),
  z.object({
    kind: z.enum(['setFrozenRowsCount', 'setFrozenColumnsCount']),
    sheet: z.number().int().min(0),
    count: z.number().int().min(0),
  }),
  z.object({
    kind: z.literal('paste'),
    sheet: z.number().int().min(0),
    row: z.number().int().min(1),
    column: z.number().int().min(1),
    isCut: z.boolean(),
  }),
  z.object({ kind: z.enum(['undo', 'redo']) }),
])
export type SpreadsheetIntent = z.infer<typeof SpreadsheetIntentSchema>

/** Caller-supplied and ADVISORY ONLY: it feeds the structural-conflict check,
 *  the filter remap and audit text, and is never an input to authorization,
 *  tenancy or permission decisions. */
export const SpreadsheetBatchSummarySchema = z.object({
  structuralKind: SpreadsheetStructuralKindSchema.nullable(),
  sheetIndexes: z.array(z.number().int().min(0)).max(SPREADSHEET_LIMITS.maxSheets),
  cellCount: z.number().int().min(0),
  touched: z.array(SpreadsheetRectangleSchema).max(SPREADSHEET_LIMITS.maxTouchedRectangles),
  intents: z.array(SpreadsheetIntentSchema).max(SPREADSHEET_LIMITS.maxIntentsPerBatch).optional(),
})
export type SpreadsheetBatchSummary = z.infer<typeof SpreadsheetBatchSummarySchema>

const Base64Schema = z.string().base64()

export const SpreadsheetOpBatchInputSchema = z.object({
  clientOpId: z.string().uuid(),
  baseSeq: z.number().int().min(0),
  diffs: Base64Schema,
  summary: SpreadsheetBatchSummarySchema,
})
export type SpreadsheetOpBatchInput = z.infer<typeof SpreadsheetOpBatchInputSchema>

export const SpreadsheetAppliedBatchSchema = z.object({
  batchId: z.string().uuid(),
  pageId: z.string().uuid(),
  seq: z.number().int().min(1),
  baseSeq: z.number().int().min(0),
  clientOpId: z.string().uuid(),
  actor: SpreadsheetActorSchema,
  engineVersion: z.string().min(1).max(32),
  /** null when the batch exceeded the fan-out cap: fetch it by seq. */
  diffs: Base64Schema.nullable(),
  structuralKind: SpreadsheetStructuralKindSchema.nullable(),
  sheetIndexes: z.array(z.number().int().min(0)),
  cellCount: z.number().int().min(0),
  createdAt: z.string().datetime(),
})
export type SpreadsheetAppliedBatch = z.infer<typeof SpreadsheetAppliedBatchSchema>

// ------------------------------------------------------------------ presence

export const SpreadsheetPresenceFrameSchema = z.object({
  clientId: z.string().min(1).max(64),
  sheet: z.number().int().min(0),
  selection: SpreadsheetSelectionSchema,
  cursor: z.object({ r: z.number().int().min(1), c: z.number().int().min(1) }).nullable(),
  draft: z
    .object({
      r: z.number().int().min(1),
      c: z.number().int().min(1),
      text: z.string().max(SPREADSHEET_LIMITS.maxDraftChars),
    })
    .nullable(),
  ts: z.string().datetime(),
})
export type SpreadsheetPresenceFrame = z.infer<typeof SpreadsheetPresenceFrameSchema>

export const SpreadsheetPresenceEventSchema = SpreadsheetPresenceFrameSchema.extend({
  pageId: z.string().uuid(),
  actor: SpreadsheetActorSchema,
  sheetName: z.string().max(200),
})
export type SpreadsheetPresenceEvent = z.infer<typeof SpreadsheetPresenceEventSchema>

// ----------------------------------------------------------------- bootstrap

export const SpreadsheetSheetInfoSchema = z.object({
  index: z.number().int().min(0),
  name: z.string().min(1).max(200),
  hidden: z.boolean(),
  color: z.string().nullable(),
})
export type SpreadsheetSheetInfo = z.infer<typeof SpreadsheetSheetInfoSchema>

export const SpreadsheetBootstrapSchema = z.object({
  pageId: z.string().uuid(),
  title: z.string(),
  revision: z.number().int().min(0),
  engineVersion: z.string().min(1).max(32),
  headSeq: z.number().int().min(0),
  snapshot: z.object({ seq: z.number().int().min(0), bytes: Base64Schema }),
  batches: z.array(SpreadsheetAppliedBatchSchema),
  sheets: z.array(SpreadsheetSheetInfoSchema),
  viewer: z.object({
    canWrite: z.boolean(),
    actor: SpreadsheetActorSchema,
  }),
})
export type SpreadsheetBootstrap = z.infer<typeof SpreadsheetBootstrapSchema>

export const SPREADSHEET_ERROR_CODES = {
  engineMismatch: 'SPREADSHEET_ENGINE_MISMATCH',
  structuralConflict: 'SPREADSHEET_STRUCTURAL_CONFLICT',
  batchRejected: 'SPREADSHEET_BATCH_REJECTED',
  engineUnavailable: 'SPREADSHEET_ENGINE_UNAVAILABLE',
  tooLarge: 'SPREADSHEET_TOO_LARGE',
  unsupportedFeature: 'SPREADSHEET_UNSUPPORTED_FEATURE',
} as const
