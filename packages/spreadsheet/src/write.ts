import {
  SPREADSHEET_LIMITS,
  selectionCellCount,
  type SpreadsheetBatchSummary,
  type SpreadsheetRectangle,
  type SpreadsheetSelection,
  type SpreadsheetStructuralKind,
  SPREADSHEET_ERROR_CODES,
} from '@nessie/schemas'

import { formatA1Range, rectangleOf, tooLarge } from './a1.js'
import { SpreadsheetEngineError, type SpreadsheetEngineModel } from './engine.js'

// Writes. Every function here follows the same three rules:
//
//  1. its engine calls happen inside `pauseEvaluation()` … `resumeEvaluation();
//     evaluate()` — un-paused, 200 000 diffs took 38 minutes against 164 ms;
//  2. it returns the exact `SpreadsheetBatchSummary` the write door needs, and
//  3. it leaves the diffs in the model's send queue. Flushing is the caller's
//     job, because only the caller knows whether this write is one batch on its
//     own or one step of a bigger one (sort is a dozen thousand calls, one
//     batch).
//
// Summaries carry no `intents`: intents are the browser's record of its own
// method calls, for replay after a structural refusal. A server-built batch is
// built at head and never conflicts.

/** Run `body` with evaluation paused, then resume and evaluate exactly once. */
export function runPaused<T>(model: SpreadsheetEngineModel, body: () => T): T {
  model.pauseEvaluation()
  let result: T
  try {
    result = body()
  } finally {
    model.resumeEvaluation()
  }
  model.evaluate()
  return result
}

export function summaryOf(
  structuralKind: SpreadsheetStructuralKind | null,
  sheetIndexes: number[],
  cellCount: number,
  touched: SpreadsheetRectangle[],
): SpreadsheetBatchSummary {
  return {
    structuralKind,
    sheetIndexes: [...new Set(sheetIndexes)].sort((a, b) => a - b),
    cellCount,
    touched: touched.slice(0, SPREADSHEET_LIMITS.maxTouchedRectangles),
  }
}

function rejected(message: string): SpreadsheetEngineError {
  return new SpreadsheetEngineError(SPREADSHEET_ERROR_CODES.batchRejected, message)
}

// ------------------------------------------------------------------ contents

export type SpreadsheetCellInput = string | number | boolean | null | undefined

export interface WriteRangeInput {
  sheet: number
  anchor: { row: number; column: number }
  /** Row-major. `null`/`undefined` clears the cell; everything else is stringified. */
  rows: readonly (readonly SpreadsheetCellInput[])[]
}

function asInput(value: SpreadsheetCellInput): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  return String(value)
}

export function writeRange(model: SpreadsheetEngineModel, input: WriteRangeInput): SpreadsheetBatchSummary {
  const height = input.rows.length
  const width = input.rows.reduce((widest, row) => Math.max(widest, row.length), 0)
  if (height === 0 || width === 0) return summaryOf(null, [input.sheet], 0, [])
  const range: SpreadsheetSelection = {
    r0: input.anchor.row,
    c0: input.anchor.column,
    r1: input.anchor.row + height - 1,
    c1: input.anchor.column + width - 1,
  }
  const count = selectionCellCount(range)
  if (count > SPREADSHEET_LIMITS.maxCellsPerWrite) {
    throw tooLarge(`${formatA1Range(range)} is ${count} cells, over the ${SPREADSHEET_LIMITS.maxCellsPerWrite}-cell write limit`)
  }
  let written = 0
  runPaused(model, () => {
    for (let r = 0; r < height; r++) {
      const row = input.rows[r] ?? []
      for (let c = 0; c < width; c++) {
        const text = asInput(row[c])
        if (text.length > SPREADSHEET_LIMITS.maxCellTextChars) {
          throw tooLarge(`cell value at row ${input.anchor.row + r} is ${text.length} characters`)
        }
        model.setUserInput(input.sheet, input.anchor.row + r, input.anchor.column + c, text)
        written++
      }
    }
  })
  return summaryOf(null, [input.sheet], written, [rectangleOf(input.sheet, range)])
}

export interface ClearRangeInput {
  sheet: number
  range: SpreadsheetSelection
  kind?: 'all' | 'contents' | 'formatting'
}

export function clearRange(model: SpreadsheetEngineModel, input: ClearRangeInput): SpreadsheetBatchSummary {
  const count = selectionCellCount(input.range)
  runPaused(model, () => model.rangeClear(input.kind ?? 'contents', input.sheet, input.range))
  return summaryOf(null, [input.sheet], count, [rectangleOf(input.sheet, input.range)])
}

// -------------------------------------------------------------------- format

export interface StyleEdit {
  /** `"font.b"`, `"font.color"`, `"fill.fg_color"`, `"alignment.horizontal"`, `"num_fmt"`. */
  path: string
  /** Always a string: `"true"`, `"#FF5566"`, `"center"`, `"#,##0.00"`. */
  value: string
}

export interface FormatRangeInput {
  sheet: number
  range: SpreadsheetSelection
  styles: readonly StyleEdit[]
}

export function formatRange(model: SpreadsheetEngineModel, input: FormatRangeInput): SpreadsheetBatchSummary {
  if (input.styles.length === 0) throw rejected('formatRange needs at least one style edit')
  const count = selectionCellCount(input.range)
  if (count > SPREADSHEET_LIMITS.maxCellsPerWrite) {
    throw tooLarge(`${formatA1Range(input.range)} is ${count} cells, over the write limit`)
  }
  runPaused(model, () => {
    for (const style of input.styles) model.updateRangeStyle(input.sheet, input.range, style.path, style.value)
  })
  return summaryOf(null, [input.sheet], count, [rectangleOf(input.sheet, input.range)])
}

// --------------------------------------------------------------- restructure

export type RestructureAction =
  | { kind: 'insertRows' | 'deleteRows'; sheet: number; row: number; count: number }
  | { kind: 'insertColumns' | 'deleteColumns'; sheet: number; column: number; count: number }
  | { kind: 'moveRows' | 'moveColumns'; sheet: number; start: number; count: number; delta: number }
  | { kind: 'setRowsHidden' | 'setColumnsHidden'; sheet: number; start: number; end: number; hidden: boolean }
  | { kind: 'setRowsHeight' | 'setColumnsWidth'; sheet: number; start: number; end: number; size: number }
  | { kind: 'setFrozenRowsCount' | 'setFrozenColumnsCount'; sheet: number; count: number }

const WHOLE_ROW = { c0: 1, c1: 16_384 }
const WHOLE_COLUMN = { r0: 1, r1: 1_048_576 }

/**
 * Row/column structure. `setRowsHidden`, the sizes and the frozen counts are
 * here too because they belong to the same axis, but they are NOT structural:
 * they move nothing, so they carry `structuralKind: null` and never cost a
 * crossing client a rebase.
 */
export function restructure(model: SpreadsheetEngineModel, action: RestructureAction): SpreadsheetBatchSummary {
  const sheet = action.sheet
  switch (action.kind) {
    case 'insertRows':
    case 'deleteRows': {
      const rows = { r0: action.row, r1: action.row + action.count - 1, ...WHOLE_ROW }
      runPaused(model, () =>
        action.kind === 'insertRows'
          ? model.insertRows(sheet, action.row, action.count)
          : model.deleteRows(sheet, action.row, action.count),
      )
      return summaryOf(action.kind, [sheet], 0, [rectangleOf(sheet, rows)])
    }
    case 'insertColumns':
    case 'deleteColumns': {
      const columns = { c0: action.column, c1: action.column + action.count - 1, ...WHOLE_COLUMN }
      runPaused(model, () =>
        action.kind === 'insertColumns'
          ? model.insertColumns(sheet, action.column, action.count)
          : model.deleteColumns(sheet, action.column, action.count),
      )
      return summaryOf(action.kind, [sheet], 0, [rectangleOf(sheet, columns)])
    }
    case 'moveRows':
    case 'moveColumns': {
      if (action.delta === 0) return summaryOf(action.kind, [sheet], 0, [])
      const rows = action.kind === 'moveRows'
      const from = action.start
      const to = action.start + action.delta
      const span = {
        r0: rows ? Math.min(from, to) : 1,
        r1: rows ? Math.max(from, to) + action.count - 1 : WHOLE_COLUMN.r1,
        c0: rows ? 1 : Math.min(from, to),
        c1: rows ? WHOLE_ROW.c1 : Math.max(from, to) + action.count - 1,
      }
      runPaused(model, () =>
        rows
          ? model.moveRows(sheet, action.start, action.count, action.delta)
          : model.moveColumns(sheet, action.start, action.count, action.delta),
      )
      return summaryOf(action.kind, [sheet], 0, [rectangleOf(sheet, span)])
    }
    case 'setRowsHidden':
    case 'setColumnsHidden': {
      const rows = action.kind === 'setRowsHidden'
      runPaused(model, () =>
        rows
          ? model.setRowsHidden(sheet, action.start, action.end, action.hidden)
          : model.setColumnsHidden(sheet, action.start, action.end, action.hidden),
      )
      const span = rows
        ? { r0: action.start, r1: action.end, ...WHOLE_ROW }
        : { c0: action.start, c1: action.end, ...WHOLE_COLUMN }
      return summaryOf(null, [sheet], 0, [rectangleOf(sheet, span)])
    }
    case 'setRowsHeight':
    case 'setColumnsWidth': {
      const rows = action.kind === 'setRowsHeight'
      runPaused(model, () =>
        rows
          ? model.setRowsHeight(sheet, action.start, action.end, action.size)
          : model.setColumnsWidth(sheet, action.start, action.end, action.size),
      )
      const span = rows
        ? { r0: action.start, r1: action.end, ...WHOLE_ROW }
        : { c0: action.start, c1: action.end, ...WHOLE_COLUMN }
      return summaryOf(null, [sheet], 0, [rectangleOf(sheet, span)])
    }
    case 'setFrozenRowsCount':
    case 'setFrozenColumnsCount': {
      runPaused(model, () =>
        action.kind === 'setFrozenRowsCount'
          ? model.setFrozenRowsCount(sheet, action.count)
          : model.setFrozenColumnsCount(sheet, action.count),
      )
      return summaryOf(null, [sheet], 0, [])
    }
  }
}

// ---------------------------------------------------------------------- tabs

export type TabAction =
  | { kind: 'addSheet'; name?: string }
  | { kind: 'deleteSheet'; sheet: number }
  | { kind: 'renameSheet'; sheet: number; name: string }
  | { kind: 'moveSheet'; sheet: number; toIndex: number }
  | { kind: 'hideSheet' | 'unhideSheet'; sheet: number }

/**
 * Sheet-level structure. `newSheet()` always appends, so the new sheet's index
 * is the old sheet count — the caller does not choose it, and `addSheet`
 * reports the index it got.
 */
export function manageTabs(model: SpreadsheetEngineModel, action: TabAction): SpreadsheetBatchSummary {
  const before = model.sheets()
  switch (action.kind) {
    case 'addSheet': {
      if (before.length >= SPREADSHEET_LIMITS.maxSheets) {
        throw tooLarge(`the workbook already has ${before.length} sheets, the limit is ${SPREADSHEET_LIMITS.maxSheets}`)
      }
      const index = before.length
      runPaused(model, () => {
        model.newSheet()
        if (action.name !== undefined) model.renameSheet(index, action.name)
      })
      return summaryOf('addSheet', [index], 0, [])
    }
    case 'deleteSheet': {
      if (before.length <= 1) throw rejected('a workbook must keep at least one sheet')
      requireSheet(before.length, action.sheet)
      runPaused(model, () => model.deleteSheet(action.sheet))
      return summaryOf('deleteSheet', [action.sheet], 0, [])
    }
    case 'renameSheet': {
      requireSheet(before.length, action.sheet)
      const name = action.name.trim()
      if (!name) throw rejected('a sheet name cannot be blank')
      const clash = before.findIndex((sheet, index) => index !== action.sheet && sheet.name === name)
      if (clash !== -1) throw rejected(`another sheet is already named ${JSON.stringify(name)}`)
      runPaused(model, () => model.renameSheet(action.sheet, name))
      return summaryOf('renameSheet', [action.sheet], 0, [])
    }
    case 'moveSheet': {
      requireSheet(before.length, action.sheet)
      requireSheet(before.length, action.toIndex)
      runPaused(model, () => model.moveSheet(action.sheet, action.toIndex))
      return summaryOf('moveSheet', [action.sheet, action.toIndex], 0, [])
    }
    case 'hideSheet':
    case 'unhideSheet': {
      requireSheet(before.length, action.sheet)
      runPaused(model, () =>
        action.kind === 'hideSheet' ? model.hideSheet(action.sheet) : model.unhideSheet(action.sheet),
      )
      return summaryOf(null, [action.sheet], 0, [])
    }
  }
}

function requireSheet(count: number, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw rejected(`sheet index ${index} is outside the workbook's ${count} sheet(s)`)
  }
}
