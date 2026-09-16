import {
  SPREADSHEET_ERROR_CODES,
  SPREADSHEET_LIMITS,
  selectionCellCount,
  type SpreadsheetBatchSummary,
  type SpreadsheetSelection,
} from '@nessie/schemas'

import { formatA1Range, rectangleOf, tooLarge } from './a1.js'
import { SpreadsheetEngineError, type SpreadsheetCellStyle, type SpreadsheetEngineModel } from './engine.js'
import { isFormula, shiftFormula, type TokenizeOptions } from './formula-shift.js'
import { runPaused, summaryOf } from './write.js'

// Full-fidelity sort, built in our layer because IronCalc 0.8 has none.
//
// It does NOT use the engine's `moveRows`: measured at 564 s for 10 000 rows,
// and it corrupted a range outside the sorted block. Instead the range is read
// as (content, style) per cell, the rows are ordered here, and the block is
// written back with `setUserInput` + `setCellStyle` inside ONE paused batch.
//
// There is no merged-cell case. Neither binding exposes a merge API at all
// (decisions.md, spike-b-xlsx.md), so the plan's "sort refuses a range with
// merges" describes a check that cannot be written and is void. Merges in an
// imported file survive inside the Rust model; they are invisible from here.
//
// Formulas keep their meaning by copy semantics: a formula that moves from row
// r to row t is rewritten by (t - r, 0) through `formula-shift.ts`, so `=B5*2`
// in C5 sorted to C2 becomes `=B2*2` and `=$F$1` stays put.

export interface SortKey {
  /** Absolute column index, inside the sorted range. */
  column: number
  direction?: 'asc' | 'desc'
}

export interface SortRangeInput extends TokenizeOptions {
  sheet: number
  range: SpreadsheetSelection
  keys: readonly SortKey[]
  /** The first row (or column) of the range is a header and stays put. */
  hasHeader?: boolean
  /** `'rows'` reorders rows by key columns (default); `'columns'` transposes it. */
  axis?: 'rows' | 'columns'
  /** For locale-aware text ordering; defaults to the runtime's own collation. */
  locale?: string
  /** When given, a reference to a sheet outside this list becomes `#REF!`. */
  sheetNames?: readonly string[]
}

interface Cell {
  content: string
  style: SpreadsheetCellStyle
}

/** Numbers sort before text, text before booleans/errors, blanks always last. */
const CLASS_BLANK = 3
const CLASS_NUMBER = 0
const CLASS_TEXT = 1
const CLASS_OTHER = 2

interface SortValue {
  rank: number
  number: number
  text: string
}

function transpose<T>(matrix: T[][]): T[][] {
  const height = matrix.length
  const width = matrix[0]?.length ?? 0
  return Array.from({ length: width }, (_, c) => Array.from({ length: height }, (_, r) => matrix[r]![c]!))
}

function rejected(message: string): SpreadsheetEngineError {
  return new SpreadsheetEngineError(SPREADSHEET_ERROR_CODES.batchRejected, message)
}

function valueOf(model: SpreadsheetEngineModel, sheet: number, row: number, column: number): SortValue {
  const formatted = model.formattedValue(sheet, row, column) ?? ''
  const content = model.cellContent(sheet, row, column) ?? ''
  if (content === '' && formatted === '') return { rank: CLASS_BLANK, number: 0, text: '' }
  const type = model.cellType(sheet, row, column)
  // CellType: 1 Number, 2 Text, 4 LogicalValue, 16 ErrorValue, 64 Array.
  if (type === 1) {
    const raw = isFormula(content) ? Number(formatted.replace(/[^\d.eE+-]/g, '')) : Number(content)
    const number = Number.isFinite(raw) ? raw : Number(formatted.replace(/[^\d.eE+-]/g, ''))
    return { rank: CLASS_NUMBER, number: Number.isFinite(number) ? number : 0, text: formatted }
  }
  if (type === 2) return { rank: CLASS_TEXT, number: 0, text: formatted }
  return { rank: CLASS_OTHER, number: 0, text: formatted }
}

function compare(a: SortValue, b: SortValue, collator: Intl.Collator): number {
  if (a.rank !== b.rank) return a.rank - b.rank
  if (a.rank === CLASS_BLANK) return 0
  if (a.rank === CLASS_NUMBER) return a.number === b.number ? 0 : a.number < b.number ? -1 : 1
  return collator.compare(a.text, b.text)
}

/**
 * Blanks sink to the bottom in both directions, the Excel and Sheets rule: a
 * descending sort reverses the values, not the empties. So the blank test sits
 * outside the direction flip rather than inside `compare`.
 */
function compareForDirection(
  a: SortValue,
  b: SortValue,
  collator: Intl.Collator,
  descending: boolean,
): number {
  if (a.rank === CLASS_BLANK || b.rank === CLASS_BLANK) {
    if (a.rank === b.rank) return 0
    return a.rank === CLASS_BLANK ? 1 : -1
  }
  const result = compare(a, b, collator)
  return descending ? -result : result
}

/**
 * The permutation only — exposed so a caller (and the tests) can see the order
 * a sort would produce without writing anything. `order[i]` is the source line
 * that ends up at destination line `i`, both 0-based within the sorted block.
 */
export function sortOrder(
  model: SpreadsheetEngineModel,
  input: SortRangeInput,
): { order: number[]; first: number; count: number } {
  const byRows = (input.axis ?? 'rows') === 'rows'
  const range = input.range
  const first = (byRows ? range.r0 : range.c0) + (input.hasHeader ? 1 : 0)
  const last = byRows ? range.r1 : range.c1
  const count = Math.max(0, last - first + 1)
  if (input.keys.length === 0) throw rejected('a sort needs at least one key')
  for (const key of input.keys) {
    const within = byRows
      ? key.column >= range.c0 && key.column <= range.c1
      : key.column >= range.r0 && key.column <= range.r1
    if (!within) {
      throw rejected(`sort key ${key.column} is outside ${formatA1Range(range)}`)
    }
  }
  const collator = new Intl.Collator(input.locale, { numeric: true, sensitivity: 'variant' })
  const lines = Array.from({ length: count }, (_, index) => first + index)
  const cached = new Map<string, SortValue>()
  const keyValue = (line: number, key: SortKey): SortValue => {
    const cacheKey = `${line}:${key.column}`
    let value = cached.get(cacheKey)
    if (!value) {
      value = byRows ? valueOf(model, input.sheet, line, key.column) : valueOf(model, input.sheet, key.column, line)
      cached.set(cacheKey, value)
    }
    return value
  }
  const decorated = lines.map((line, index) => ({ line, index }))
  decorated.sort((a, b) => {
    for (const key of input.keys) {
      const result = compareForDirection(
        keyValue(a.line, key),
        keyValue(b.line, key),
        collator,
        (key.direction ?? 'asc') === 'desc',
      )
      if (result !== 0) return result
    }
    return a.index - b.index // stable: equal keys keep their original order
  })
  return { order: decorated.map((entry) => entry.line - first), first, count }
}

/**
 * Sort `range` in place and return the batch summary. The diffs are left in the
 * model's send queue for the caller to flush, like every other write here.
 */
export function sortRange(model: SpreadsheetEngineModel, input: SortRangeInput): SpreadsheetBatchSummary {
  const cells = selectionCellCount(input.range)
  if (cells > SPREADSHEET_LIMITS.maxCellsPerWrite) {
    throw tooLarge(`${formatA1Range(input.range)} is ${cells} cells, over the ${SPREADSHEET_LIMITS.maxCellsPerWrite}-cell write limit`)
  }
  const byRows = (input.axis ?? 'rows') === 'rows'
  const { order, first, count } = sortOrder(model, input)
  if (count <= 1) return summaryOf('sort', [input.sheet], 0, [rectangleOf(input.sheet, input.range)])

  const crossFirst = byRows ? input.range.c0 : input.range.r0
  const crossLast = byRows ? input.range.c1 : input.range.r1
  const crossCount = crossLast - crossFirst + 1

  // Read the whole block first: the write below overwrites lines we still
  // need to read from, so nothing may be read lazily.
  const block: Cell[][] = []
  for (let line = 0; line < count; line++) {
    const row: Cell[] = []
    for (let cross = 0; cross < crossCount; cross++) {
      const r = byRows ? first + line : crossFirst + cross
      const c = byRows ? crossFirst + cross : first + line
      row.push({ content: model.cellContent(input.sheet, r, c) ?? '', style: model.cellStyle(input.sheet, r, c) })
    }
    block.push(row)
  }

  let written = 0
  const moved = order.some((source, destination) => source !== destination)
  runPaused(model, () => {
    for (let destination = 0; destination < count; destination++) {
      const source = order[destination]!
      if (source === destination) continue
      const line = block[source]!
      for (let cross = 0; cross < crossCount; cross++) {
        const cell = line[cross]!
        const r = byRows ? first + destination : crossFirst + cross
        const c = byRows ? crossFirst + cross : first + destination
        const content = isFormula(cell.content)
          ? shiftFormula(cell.content, {
              dr: byRows ? destination - source : 0,
              dc: byRows ? 0 : destination - source,
              ...(input.getTokens ? { getTokens: input.getTokens } : {}),
              ...(input.sheetNames ? { sheetNames: input.sheetNames } : {}),
            })
          : cell.content
        model.setUserInput(input.sheet, r, c, content)
        written++
      }
    }
    // Styles go in one paste of the whole reordered block: the engine has no
    // per-cell style setter at runtime, only `onPasteStyles` over a matrix.
    if (!moved) return
    const styles = order.map((source) => block[source]!.map((cell) => cell.style))
    model.setRangeStyles(
      input.sheet,
      byRows ? first : crossFirst,
      byRows ? crossFirst : first,
      byRows ? styles : transpose(styles),
    )
  })
  return summaryOf('sort', [input.sheet], written, [rectangleOf(input.sheet, input.range)])
}
