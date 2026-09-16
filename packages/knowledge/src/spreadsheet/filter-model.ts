import { z } from 'zod'
import {
  SpreadsheetSelectionSchema,
  type SpreadsheetBatchSummary,
  type SpreadsheetIntent,
} from '@nessie/schemas'

/**
 * The filter model and its structural remap.
 *
 * IronCalc has no autofilter, so the model is ours: it lives on
 * `spreadsheet_heads.filters`, keyed by sheet index, and is the only thing
 * that persists a filter — an imported `<autoFilter>` is read into the
 * engine's `Table` type and never written back out, so the xlsx export cannot
 * carry it either (spike B §"Contract changes" 7).
 *
 * TODO(Phase 1): when `packages/spreadsheet/src/filter.ts` lands, this schema
 * moves beside it in `@nessie/schemas` and `filter-eval.ts` is deleted in
 * favour of its criteria evaluator. The head storage and the remap below stay
 * here — they are the write door's business.
 *
 * docs/plans/2026-09-15-spreadsheets-ironcalc/storage-and-concurrency.md
 */

export const SpreadsheetFilterConditionSchema = z.object({
  kind: z.literal('condition'),
  op: z.enum([
    'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
    'contains', 'notContains', 'startsWith', 'endsWith',
    'empty', 'notEmpty', 'between',
  ]),
  value: z.union([z.string().max(1_000), z.number()]).optional(),
  value2: z.union([z.string().max(1_000), z.number()]).optional(),
  caseSensitive: z.boolean().optional(),
})

export const SpreadsheetFilterValuesSchema = z.object({
  kind: z.literal('values'),
  /** A whitelist of *formatted* values, which is what a person sees and picks. */
  values: z.array(z.string().max(1_000)).max(10_000),
  blanks: z.boolean(),
})

export const SpreadsheetFilterColumnSchema = z.discriminatedUnion('kind', [
  SpreadsheetFilterValuesSchema,
  SpreadsheetFilterConditionSchema,
])
export type SpreadsheetFilterColumn = z.infer<typeof SpreadsheetFilterColumnSchema>

export const SpreadsheetFilterModelSchema = z.object({
  /** Header row is `r0`. */
  range: SpreadsheetSelectionSchema,
  /** Keyed by absolute column index, as a string because it lives in JSON. */
  columns: z.record(z.string(), SpreadsheetFilterColumnSchema),
  sort: z
    .object({ column: z.number().int().min(1), direction: z.enum(['asc', 'desc']) })
    .optional(),
  /**
   * Rows *this model* hid, so clearing the filter unhides exactly those and
   * never a row somebody hid by hand.
   */
  hiddenRows: z.array(z.number().int().min(1)).max(1_000_000).default([]),
  appliedAtSeq: z.number().int().min(0).default(0),
})
export type SpreadsheetFilterModel = z.infer<typeof SpreadsheetFilterModelSchema>

export const SpreadsheetFiltersSchema = z.record(z.string(), SpreadsheetFilterModelSchema)
export type SpreadsheetFilters = z.infer<typeof SpreadsheetFiltersSchema>

/** A head's `filters` column, or `{}` when it is absent or unreadable. */
export const parseFilters = (value: unknown): SpreadsheetFilters => {
  const parsed = SpreadsheetFiltersSchema.safeParse(value ?? {})
  return parsed.success ? parsed.data : {}
}

const shiftPoint = (point: number, at: number, delta: number): number =>
  point >= at ? Math.max(1, point + delta) : point

const shiftColumns = (
  columns: SpreadsheetFilterModel['columns'],
  at: number,
  delta: number,
): SpreadsheetFilterModel['columns'] => {
  const next: SpreadsheetFilterModel['columns'] = {}
  for (const [key, value] of Object.entries(columns)) {
    const column = Number(key)
    if (!Number.isFinite(column)) continue
    // A deleted column takes its criteria with it.
    if (delta < 0 && column >= at && column < at - delta) continue
    next[String(shiftPoint(column, at, delta))] = value
  }
  return next
}

const applyRowShift = (
  model: SpreadsheetFilterModel,
  at: number,
  delta: number,
): SpreadsheetFilterModel | null => {
  const range = {
    ...model.range,
    r0: shiftPoint(model.range.r0, at, delta),
    r1: shiftPoint(model.range.r1, at, delta),
  }
  // The whole filtered block was deleted: the model has nothing left to describe.
  if (range.r1 < range.r0) return null
  return {
    ...model,
    range,
    hiddenRows: model.hiddenRows
      .map((row) => (delta < 0 && row >= at && row < at - delta ? 0 : shiftPoint(row, at, delta)))
      .filter((row) => row > 0),
  }
}

const applyColumnShift = (
  model: SpreadsheetFilterModel,
  at: number,
  delta: number,
): SpreadsheetFilterModel | null => {
  const range = {
    ...model.range,
    c0: shiftPoint(model.range.c0, at, delta),
    c1: shiftPoint(model.range.c1, at, delta),
  }
  if (range.c1 < range.c0) return null
  return { ...model, range, columns: shiftColumns(model.columns, at, delta) }
}

const remapForIntent = (
  model: SpreadsheetFilterModel,
  intent: SpreadsheetIntent,
): SpreadsheetFilterModel | null => {
  switch (intent.kind) {
    case 'insertRows':
      return applyRowShift(model, intent.row, intent.count)
    case 'deleteRows':
      return applyRowShift(model, intent.row, -intent.count)
    case 'insertColumns':
      return applyColumnShift(model, intent.column, intent.count)
    case 'deleteColumns':
      return applyColumnShift(model, intent.column, -intent.count)
    case 'moveRows':
    case 'moveColumns':
      // A move reorders rows the filter's hidden set was computed from, so the
      // set is no longer trustworthy — but the range and the criteria still
      // describe what the person asked for. Keep them, forget the hidden rows,
      // and let the next explicit re-apply rebuild the set.
      return { ...model, hiddenRows: [] }
    default:
      return model
  }
}

/**
 * Shift every sheet's filter model by one applied batch.
 *
 * Driven by `summary.intents`, which is the only place the batch says *where*
 * it inserted or deleted — and, like every other use of the summary, advisory:
 * a wrong or missing intent costs a stale filter that the next re-apply
 * rebuilds, never an access decision. A structural batch that declares no
 * intent leaves the model untouched; `reapplyFilter` validates the range
 * against the live sheet and drops a model that no longer fits.
 */
export const remapFiltersForBatch = (
  current: unknown,
  summary: SpreadsheetBatchSummary,
): SpreadsheetFilters => {
  const filters = parseFilters(current)
  if (!summary.structuralKind || !summary.intents || summary.intents.length === 0) return filters

  const next: SpreadsheetFilters = { ...filters }
  for (const intent of summary.intents) {
    if (!('sheet' in intent)) continue
    const key = String(intent.sheet)
    const model = next[key]
    if (!model) continue
    const remapped = remapForIntent(model, intent)
    if (remapped) next[key] = remapped
    else delete next[key]
  }
  return next
}

/** Sheet insert/delete/move re-key the whole map, because the keys *are* indexes. */
export const rekeyFiltersForSheetChange = (
  current: unknown,
  change:
    | { kind: 'addSheet'; at: number }
    | { kind: 'deleteSheet'; at: number }
    | { kind: 'moveSheet'; from: number; to: number },
): SpreadsheetFilters => {
  const filters = parseFilters(current)
  const next: SpreadsheetFilters = {}
  for (const [key, model] of Object.entries(filters)) {
    const sheet = Number(key)
    if (!Number.isFinite(sheet)) continue
    if (change.kind === 'addSheet') {
      next[String(sheet >= change.at ? sheet + 1 : sheet)] = model
    } else if (change.kind === 'deleteSheet') {
      if (sheet === change.at) continue
      next[String(sheet > change.at ? sheet - 1 : sheet)] = model
    } else {
      const { from, to } = change
      let moved = sheet
      if (sheet === from) moved = to
      else if (from < sheet && sheet <= to) moved = sheet - 1
      else if (to <= sheet && sheet < from) moved = sheet + 1
      next[String(moved)] = model
    }
  }
  return next
}
