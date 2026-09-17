import {
  SPREADSHEET_ERROR_CODES,
  SPREADSHEET_MAX_COLUMNS,
  SPREADSHEET_MAX_ROWS,
  SpreadsheetFilterModelSchema,
  type SpreadsheetBatchSummary,
  type SpreadsheetFilterModel,
  type SpreadsheetIntent,
  type SpreadsheetSelection,
} from '@nessie/schemas'

import { rectangleOf } from './a1.js'
import { SpreadsheetEngineError, type SpreadsheetEngineModel } from './engine.js'
import { runPaused, summaryOf } from './write.js'

// The filter IronCalc does not have. The engine only ever learns the result —
// a `setRowsHidden` per run of rows — and the criteria live in our model on the
// page head.
//
// Two facts shape the whole file:
//
//  1. **Hidden is not queryable as a boolean.** Neither binding has a
//     `getRowsHidden`; a hidden row reports height 0 (`model.isRowHidden`
//     reads exactly that). So "did this filter hide row 7, or did a person?"
//     cannot be answered from the engine, and the model carries its own
//     `hiddenRows` list. Everything not on that list is somebody's manual hide
//     and is never touched.
//  2. **Re-application is explicit**, the Excel and Sheets rule: editing a cell
//     does not re-filter, so a row never vanishes under a person's cursor.
//     `applyFilter` is called by the pane's "Re-apply", by `sheet_filter`, and
//     automatically after a sort through the filter, an import and a restore.

export { SpreadsheetFilterModelSchema }
export type { SpreadsheetFilterModel }

export type SpreadsheetFilterColumn = SpreadsheetFilterModel['columns'][string]
export type SpreadsheetFilterCondition = Extract<SpreadsheetFilterColumn, { kind: 'condition' }>

function rejected(message: string): SpreadsheetEngineError {
  return new SpreadsheetEngineError(SPREADSHEET_ERROR_CODES.batchRejected, message)
}

export function emptyFilter(range: SpreadsheetSelection, appliedAtSeq = '0'): SpreadsheetFilterModel {
  return SpreadsheetFilterModelSchema.parse({ range, columns: {}, hiddenRows: [], appliedAtSeq })
}

// ------------------------------------------------------------------ criteria

function asNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function fold(text: string, caseSensitive: boolean | undefined): string {
  return caseSensitive ? text : text.toLowerCase()
}

/** Evaluate one column's criterion against one cell's formatted value. */
export function matchesColumn(criterion: SpreadsheetFilterColumn, cell: string): boolean {
  if (criterion.kind === 'values') {
    if (cell === '') return criterion.blanks
    return criterion.values.includes(cell)
  }
  const sensitive = criterion.caseSensitive
  const left = fold(cell, sensitive)
  const right = fold(typeof criterion.value === 'number' ? String(criterion.value) : (criterion.value ?? ''), sensitive)
  const leftNumber = asNumber(cell)
  const rightNumber = asNumber(criterion.value)
  const numeric = leftNumber !== null && rightNumber !== null
  switch (criterion.op) {
    case 'empty':
      return cell === ''
    case 'notEmpty':
      return cell !== ''
    case 'eq':
      return numeric ? leftNumber === rightNumber : left === right
    case 'ne':
      return numeric ? leftNumber !== rightNumber : left !== right
    case 'gt':
      return numeric ? leftNumber > rightNumber : left > right
    case 'gte':
      return numeric ? leftNumber >= rightNumber : left >= right
    case 'lt':
      return numeric ? leftNumber < rightNumber : left < right
    case 'lte':
      return numeric ? leftNumber <= rightNumber : left <= right
    case 'contains':
      return left.includes(right)
    case 'notContains':
      return !left.includes(right)
    case 'startsWith':
      return left.startsWith(right)
    case 'endsWith':
      return left.endsWith(right)
    case 'between': {
      const highNumber = asNumber(criterion.value2)
      if (leftNumber !== null && rightNumber !== null && highNumber !== null) {
        const low = Math.min(rightNumber, highNumber)
        const high = Math.max(rightNumber, highNumber)
        return leftNumber >= low && leftNumber <= high
      }
      const high = fold(typeof criterion.value2 === 'number' ? String(criterion.value2) : (criterion.value2 ?? ''), sensitive)
      const low = right <= high ? right : high
      const top = right <= high ? high : right
      return left >= low && left <= top
    }
  }
}

/** Every criterion must hold (Excel's AND across columns) for a row to stay. */
export function rowPasses(
  model: SpreadsheetEngineModel,
  sheet: number,
  filter: SpreadsheetFilterModel,
  row: number,
): boolean {
  for (const [key, criterion] of Object.entries(filter.columns)) {
    const column = Number(key)
    if (column < filter.range.c0 || column > filter.range.c1) continue
    if (!matchesColumn(criterion, model.formattedValue(sheet, row, column) ?? '')) return false
  }
  return true
}

/** The rows inside the filter's body the criteria would hide, in order. */
export function hiddenRowsFor(
  model: SpreadsheetEngineModel,
  sheet: number,
  filter: SpreadsheetFilterModel,
): number[] {
  if (Object.keys(filter.columns).length === 0) return []
  const hidden: number[] = []
  for (let row = filter.range.r0 + 1; row <= filter.range.r1; row++) {
    if (!rowPasses(model, sheet, filter, row)) hidden.push(row)
  }
  return hidden
}

// --------------------------------------------------------------- application

function runsOf(rows: readonly number[]): [number, number][] {
  const runs: [number, number][] = []
  for (const row of rows) {
    const last = runs[runs.length - 1]
    if (last && row === last[1] + 1) last[1] = row
    else runs.push([row, row])
  }
  return runs
}

export interface ApplyFilterResult {
  filter: SpreadsheetFilterModel
  summary: SpreadsheetBatchSummary
  hidden: number[]
  shown: number[]
}

/**
 * Compute the criteria against the live formatted values and emit only the
 * delta: rows this filter newly hides, and rows it previously hid that now
 * pass. A row hidden by hand and never by this filter is not in
 * `filter.hiddenRows`, so it is never unhidden here.
 */
export function applyFilter(
  model: SpreadsheetEngineModel,
  sheet: number,
  filter: SpreadsheetFilterModel,
  appliedAtSeq?: string,
): ApplyFilterResult {
  const parsed = SpreadsheetFilterModelSchema.parse(filter)
  const wanted = hiddenRowsFor(model, sheet, parsed)
  const wantedSet = new Set(wanted)
  const previous = new Set(parsed.hiddenRows)
  const toHide = wanted.filter((row) => !previous.has(row) || !model.isRowHidden(sheet, row))
  const toShow = parsed.hiddenRows.filter((row) => !wantedSet.has(row)).sort((a, b) => a - b)
  runPaused(model, () => {
    for (const [start, end] of runsOf(toShow)) model.setRowsHidden(sheet, start, end, false)
    for (const [start, end] of runsOf(toHide)) model.setRowsHidden(sheet, start, end, true)
  })
  const next: SpreadsheetFilterModel = {
    ...parsed,
    hiddenRows: wanted,
    appliedAtSeq: appliedAtSeq ?? parsed.appliedAtSeq,
  }
  return {
    filter: next,
    summary: summaryOf(null, [sheet], 0, [rectangleOf(sheet, parsed.range)]),
    hidden: toHide,
    shown: toShow,
  }
}

/** Unhide exactly the rows this filter hid, and forget the criteria. */
export function clearFilter(
  model: SpreadsheetEngineModel,
  sheet: number,
  filter: SpreadsheetFilterModel,
): ApplyFilterResult {
  const parsed = SpreadsheetFilterModelSchema.parse(filter)
  const toShow = [...parsed.hiddenRows].sort((a, b) => a - b)
  runPaused(model, () => {
    for (const [start, end] of runsOf(toShow)) model.setRowsHidden(sheet, start, end, false)
  })
  return {
    filter: { ...parsed, columns: {}, hiddenRows: [] },
    summary: summaryOf(null, [sheet], 0, [rectangleOf(sheet, parsed.range)]),
    hidden: [],
    shown: toShow,
  }
}

// ------------------------------------------------------------------- remap

export type SpreadsheetStructuralEdit =
  | { kind: 'insertRows' | 'deleteRows'; sheet: number; row: number; count: number }
  | { kind: 'insertColumns' | 'deleteColumns'; sheet: number; column: number; count: number }
  | { kind: 'moveRows' | 'moveColumns'; sheet: number; start: number; count: number; delta: number }
  | { kind: 'addSheet'; index: number }
  | { kind: 'deleteSheet'; index: number }
  | { kind: 'moveSheet'; from: number; to: number }

/**
 * The structural edits a batch summary describes. The summary's `intents` are
 * the browser's own record of the calls it made; a server-built batch has none,
 * and then the caller has to rebuild the edit from the tool call it issued.
 */
export function structuralEditsFromSummary(summary: SpreadsheetBatchSummary): SpreadsheetStructuralEdit[] {
  if (!summary.structuralKind || !summary.intents) return []
  const edits: SpreadsheetStructuralEdit[] = []
  for (const intent of summary.intents) edits.push(...structuralEditsFromIntent(intent))
  return edits
}

export function structuralEditsFromIntent(intent: SpreadsheetIntent): SpreadsheetStructuralEdit[] {
  switch (intent.kind) {
    case 'insertRows':
    case 'deleteRows':
      return [{ kind: intent.kind, sheet: intent.sheet, row: intent.row, count: intent.count }]
    case 'insertColumns':
    case 'deleteColumns':
      return [{ kind: intent.kind, sheet: intent.sheet, column: intent.column, count: intent.count }]
    case 'moveRows':
    case 'moveColumns':
      return [{ kind: intent.kind, sheet: intent.sheet, start: intent.start, count: intent.count, delta: intent.delta }]
    default:
      return []
  }
}

/** Where a single index lands after `edit`, or null when the edit removed it. */
export function shiftIndex(index: number, edit: SpreadsheetStructuralEdit, axis: 'row' | 'column'): number | null {
  const rowAxis = axis === 'row'
  switch (edit.kind) {
    case 'insertRows':
      return rowAxis && index >= edit.row ? index + edit.count : index
    case 'deleteRows': {
      if (!rowAxis) return index
      if (index >= edit.row && index < edit.row + edit.count) return null
      return index >= edit.row + edit.count ? index - edit.count : index
    }
    case 'insertColumns':
      return !rowAxis && index >= edit.column ? index + edit.count : index
    case 'deleteColumns': {
      if (rowAxis) return index
      if (index >= edit.column && index < edit.column + edit.count) return null
      return index >= edit.column + edit.count ? index - edit.count : index
    }
    case 'moveRows':
    case 'moveColumns': {
      if (rowAxis !== (edit.kind === 'moveRows')) return index
      const { start, count, delta } = edit
      if (delta === 0) return index
      if (index >= start && index < start + count) return index + delta
      if (delta > 0 && index >= start + count && index < start + count + delta) return index - count
      if (delta < 0 && index >= start + delta && index < start) return index + count
      return index
    }
    default:
      return index
  }
}

function shiftBound(index: number, edit: SpreadsheetStructuralEdit, axis: 'row' | 'column', low: boolean): number | null {
  const shifted = shiftIndex(index, edit, axis)
  if (shifted !== null) return shifted
  // The bound itself was deleted: collapse it onto the edge of the deletion.
  if (edit.kind === 'deleteRows') return low ? edit.row : edit.row - 1
  if (edit.kind === 'deleteColumns') return low ? edit.column : edit.column - 1
  return null
}

/**
 * Move a filter model through one structural edit, or drop it (null) when the
 * edit destroyed it: its whole range deleted, its sheet deleted, or a remap
 * that leaves nothing under the header row.
 */
export function remapFilter(
  filter: SpreadsheetFilterModel,
  sheet: number,
  edit: SpreadsheetStructuralEdit,
): SpreadsheetFilterModel | null {
  if (edit.kind === 'deleteSheet') return edit.index === sheet ? null : filter
  if (edit.kind === 'addSheet' || edit.kind === 'moveSheet') return filter
  if (edit.sheet !== sheet) return filter

  const r0 = shiftBound(filter.range.r0, edit, 'row', true)
  const r1 = shiftBound(filter.range.r1, edit, 'row', false)
  const c0 = shiftBound(filter.range.c0, edit, 'column', true)
  const c1 = shiftBound(filter.range.c1, edit, 'column', false)
  if (r0 === null || r1 === null || c0 === null || c1 === null) return null
  if (r1 <= r0 || c1 < c0 || r0 < 1 || c0 < 1 || r1 > SPREADSHEET_MAX_ROWS || c1 > SPREADSHEET_MAX_COLUMNS) return null

  const columns: SpreadsheetFilterModel['columns'] = {}
  for (const [key, criterion] of Object.entries(filter.columns)) {
    const moved = shiftIndex(Number(key), edit, 'column')
    if (moved === null || moved < c0 || moved > c1) continue
    columns[String(moved)] = criterion
  }
  const sort = filter.sort ? shiftIndex(filter.sort.column, edit, 'column') : null
  const hiddenRows = filter.hiddenRows
    .map((row) => shiftIndex(row, edit, 'row'))
    .filter((row): row is number => row !== null && row > r0 && row <= r1)
    .sort((a, b) => a - b)

  return {
    range: { r0, c0, r1, c1 },
    columns,
    ...(filter.sort && sort !== null ? { sort: { ...filter.sort, column: sort } } : {}),
    hiddenRows,
    appliedAtSeq: filter.appliedAtSeq,
  }
}

/** The per-sheet map on the head, moved through one edit and re-keyed. */
export function remapFilters(
  filters: Readonly<Record<string, SpreadsheetFilterModel>>,
  edit: SpreadsheetStructuralEdit,
): Record<string, SpreadsheetFilterModel> {
  const next: Record<string, SpreadsheetFilterModel> = {}
  for (const [key, filter] of Object.entries(filters)) {
    const sheet = Number(key)
    if (!Number.isInteger(sheet) || sheet < 0) throw rejected(`filter map key ${JSON.stringify(key)} is not a sheet index`)
    const moved = remapFilter(filter, sheet, edit)
    if (!moved) continue
    const index = remapSheetIndex(sheet, edit)
    if (index === null) continue
    next[String(index)] = moved
  }
  return next
}

/** Where a sheet index lands after a sheet-level edit, or null when deleted. */
export function remapSheetIndex(sheet: number, edit: SpreadsheetStructuralEdit): number | null {
  switch (edit.kind) {
    case 'addSheet':
      return sheet >= edit.index ? sheet + 1 : sheet
    case 'deleteSheet':
      if (sheet === edit.index) return null
      return sheet > edit.index ? sheet - 1 : sheet
    case 'moveSheet': {
      if (sheet === edit.from) return edit.to
      if (edit.from < edit.to && sheet > edit.from && sheet <= edit.to) return sheet - 1
      if (edit.from > edit.to && sheet >= edit.to && sheet < edit.from) return sheet + 1
      return sheet
    }
    default:
      return sheet
  }
}
