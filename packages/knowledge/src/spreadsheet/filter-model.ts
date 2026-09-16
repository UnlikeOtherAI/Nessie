import {
  SpreadsheetFilterModelSchema,
  type SpreadsheetBatchSummary,
  type SpreadsheetFilterModel,
} from '@nessie/schemas'
import { remapFilters, structuralEditsFromSummary } from '@nessie/spreadsheet'
import { z } from 'zod'

/**
 * How the filter model is stored on the head, and how the write door moves it
 * when a batch reshapes the grid.
 *
 * The model itself, its criteria and the remap arithmetic are
 * `@nessie/spreadsheet`'s (`filter.ts`) and the schema is `@nessie/schemas`'s;
 * this file owns only the `spreadsheet_heads.filters` column — reading it
 * safely and writing it back after every applied batch.
 *
 * IronCalc has no autofilter, so this model is the only thing that persists a
 * filter: an imported `<autoFilter>` is read into the engine's `Table` type and
 * never written back, and the xlsx export therefore cannot carry one either.
 */

export const SpreadsheetFiltersSchema = z.record(z.string(), SpreadsheetFilterModelSchema)
export type SpreadsheetFilters = Record<string, SpreadsheetFilterModel>

/**
 * The head's `filters` column as a map, or `{}`.
 *
 * Deliberately forgiving: a model written by an older build, or one whose
 * shape a migration changed, must not make the whole page unopenable. A
 * filter that cannot be read is a filter that is not applied, which is a
 * visible and recoverable state; a 500 on bootstrap is not.
 */
export const parseFilters = (value: unknown): SpreadsheetFilters => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const filters: SpreadsheetFilters = {}
  for (const [key, model] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) continue
    const parsed = SpreadsheetFilterModelSchema.safeParse(model)
    if (parsed.success) filters[key] = parsed.data
  }
  return filters
}

/**
 * Shift every sheet's filter model by one applied batch.
 *
 * Driven by `summary.intents`, which is the only place a batch says *where* it
 * inserted, deleted or moved. Like every other use of the summary this is
 * advisory: a wrong or missing intent costs a stale filter that the next
 * explicit re-apply rebuilds, never an access decision. A model whose range
 * the edit destroyed is dropped rather than carried forward pointing at rows
 * that no longer exist.
 */
export const remapFiltersForBatch = (
  current: unknown,
  summary: SpreadsheetBatchSummary,
): SpreadsheetFilters => {
  let filters = parseFilters(current)
  if (!summary.structuralKind) return filters
  for (const edit of structuralEditsFromSummary(summary)) {
    filters = remapFilters(filters, edit)
  }
  return filters
}

export { SpreadsheetFilterModelSchema, type SpreadsheetFilterModel }
