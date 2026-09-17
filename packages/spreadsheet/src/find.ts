import {
  SPREADSHEET_ERROR_CODES,
  type SpreadsheetBatchSummary,
  type SpreadsheetSelection,
} from '@nessie/schemas'

import { cellA1, rectangleOf } from './a1.js'
import { SpreadsheetEngineError, type SpreadsheetEngineModel } from './engine.js'
import { formulaParses, isFormula, type TokenizeOptions } from './formula-shift.js'
import { usedRange } from './read.js'
import { runPaused, summaryOf } from './write.js'

// Find and replace over a workbook, a sheet or a range. Find reads formatted
// values by default and cell contents with `inFormulas`; replace writes through
// `setUserInput` so it lands in the journal like any other edit.
//
// The one refusal: replacing inside a formula can produce text the engine
// cannot parse (`=SUM(A1:B2)` with "SUM" → "S UM"). Each replacement is
// tokenised before it is written, and a cell whose result does not parse is
// reported and left exactly as it was — the other cells still land.

export const FIND_MATCH_LIMIT = 200

export type FindScope =
  | { kind: 'workbook' }
  | { kind: 'sheet'; sheet: number }
  | { kind: 'range'; sheet: number; range: SpreadsheetSelection }

export interface FindOptions extends TokenizeOptions {
  query: string
  scope?: FindScope
  matchCase?: boolean
  wholeCell?: boolean
  regex?: boolean
  /** Search cell contents (formula text) instead of formatted values. */
  inFormulas?: boolean
  limit?: number
}

export interface SpreadsheetMatch {
  sheet: number
  sheetName: string
  row: number
  column: number
  a1: string
  /** The text that matched — a formatted value, or the formula with `inFormulas`. */
  text: string
}

export interface FindResult {
  matches: SpreadsheetMatch[]
  truncated: boolean
  scanned: number
}

function rejected(message: string): SpreadsheetEngineError {
  return new SpreadsheetEngineError(SPREADSHEET_ERROR_CODES.batchRejected, message)
}

// No RE2 in this repo, so the accepted subset is the one a backtracking engine
// cannot blow up on: no nested quantifier, no backreference, no lookaround, and
// a bounded pattern length. Anything else is refused rather than run.
const UNSAFE_REGEX = [
  /\\[1-9]/, // backreference
  /\(\?[=!<]/, // lookaround
  /[*+?}]\s*[*+]/, // quantified quantifier
  /\)[*+]\s*[*+?{]/,
  /\([^)]*[*+][^)]*\)[*+{]/, // a quantifier inside a quantified group
]

export function compileQuery(options: FindOptions): (text: string) => boolean {
  const { query } = options
  if (query === '') throw rejected('find needs a non-empty query')
  if (query.length > 1000) throw rejected('a find query is limited to 1000 characters')
  if (options.regex) {
    for (const unsafe of UNSAFE_REGEX) {
      if (unsafe.test(query)) {
        throw new SpreadsheetEngineError(
          SPREADSHEET_ERROR_CODES.unsupportedFeature,
          'this pattern can backtrack exponentially; nested quantifiers, backreferences and lookaround are not supported',
        )
      }
    }
    let expression: RegExp
    try {
      expression = new RegExp(options.wholeCell ? `^(?:${query})$` : query, options.matchCase ? 'u' : 'iu')
    } catch (error) {
      throw rejected(`not a usable pattern: ${(error as Error).message}`)
    }
    return (text) => expression.test(text)
  }
  const needle = options.matchCase ? query : query.toLowerCase()
  return (text) => {
    const hay = options.matchCase ? text : text.toLowerCase()
    return options.wholeCell ? hay === needle : hay.includes(needle)
  }
}

function scopeRanges(
  model: SpreadsheetEngineModel,
  scope: FindScope,
): { sheet: number; sheetName: string; range: SpreadsheetSelection }[] {
  const sheets = model.sheets()
  const forSheet = (sheet: number, range?: SpreadsheetSelection) => {
    const bounds = range ?? usedRange(model, sheet)
    if (!bounds) return []
    return [{ sheet, sheetName: sheets[sheet]?.name ?? `Sheet${sheet + 1}`, range: bounds }]
  }
  if (scope.kind === 'range') return forSheet(scope.sheet, scope.range)
  if (scope.kind === 'sheet') return forSheet(scope.sheet)
  return sheets.flatMap((_, index) => forSheet(index))
}

export function findInWorkbook(model: SpreadsheetEngineModel, options: FindOptions): FindResult {
  const test = compileQuery(options)
  const limit = options.limit ?? FIND_MATCH_LIMIT
  const matches: SpreadsheetMatch[] = []
  let scanned = 0
  let truncated = false
  for (const target of scopeRanges(model, options.scope ?? { kind: 'workbook' })) {
    for (let row = target.range.r0; row <= target.range.r1 && !truncated; row++) {
      for (let column = target.range.c0; column <= target.range.c1; column++) {
        scanned++
        const text = options.inFormulas
          ? (model.cellContent(target.sheet, row, column) ?? '')
          : (model.formattedValue(target.sheet, row, column) ?? '')
        if (text === '' || !test(text)) continue
        if (matches.length >= limit) {
          truncated = true
          break
        }
        matches.push({
          sheet: target.sheet,
          sheetName: target.sheetName,
          row,
          column,
          a1: cellA1(row, column),
          text,
        })
      }
    }
    if (truncated) break
  }
  return { matches, truncated, scanned }
}

// ------------------------------------------------------------------- replace

export interface ReplaceOptions extends FindOptions {
  replacement: string
}

export interface ReplacedCell extends SpreadsheetMatch {
  before: string
  after: string
}

export interface RefusedCell extends SpreadsheetMatch {
  after: string
  reason: string
}

export interface ReplaceResult {
  summary: SpreadsheetBatchSummary
  replaced: ReplacedCell[]
  refused: RefusedCell[]
  truncated: boolean
}

function replaceText(text: string, options: ReplaceOptions): string {
  if (options.regex) {
    const flags = options.matchCase ? 'gu' : 'giu'
    const expression = new RegExp(options.wholeCell ? `^(?:${options.query})$` : options.query, flags)
    return text.replace(expression, options.replacement)
  }
  if (options.wholeCell) return options.replacement
  if (options.matchCase) return text.split(options.query).join(options.replacement)
  // Case-insensitive literal replace, without turning the query into a pattern.
  const hay = text.toLowerCase()
  const needle = options.query.toLowerCase()
  let out = ''
  let cursor = 0
  for (;;) {
    const at = hay.indexOf(needle, cursor)
    if (at === -1) break
    out += text.slice(cursor, at) + options.replacement
    cursor = at + needle.length
  }
  return out + text.slice(cursor)
}

/**
 * Replace every match in scope. Cells whose replacement would leave a formula
 * the engine cannot parse are refused one by one and left untouched; the rest
 * land in a single paused batch.
 */
export function replaceInWorkbook(model: SpreadsheetEngineModel, options: ReplaceOptions): ReplaceResult {
  const found = findInWorkbook(model, options)
  const replaced: ReplacedCell[] = []
  const refused: RefusedCell[] = []
  for (const match of found.matches) {
    const before = options.inFormulas
      ? (model.cellContent(match.sheet, match.row, match.column) ?? '')
      : (model.formattedValue(match.sheet, match.row, match.column) ?? '')
    const after = replaceText(before, options)
    if (after === before) continue
    if (options.inFormulas && isFormula(after)) {
      const parses = formulaParses(after, options.getTokens ? { getTokens: options.getTokens } : {})
      if (!parses) {
        refused.push({ ...match, after, reason: 'the replacement does not parse as a formula' })
        continue
      }
    }
    // Replacing a formatted value writes a literal: the cell stops being a
    // formula, which is what Sheets does too when you replace a displayed value.
    replaced.push({ ...match, before, after })
  }
  const touched = new Map<string, { sheet: number; r0: number; c0: number; r1: number; c1: number }>()
  runPaused(model, () => {
    for (const cell of replaced) {
      model.setUserInput(cell.sheet, cell.row, cell.column, cell.after)
      const existing = touched.get(String(cell.sheet))
      if (!existing) {
        touched.set(
          String(cell.sheet),
          rectangleOf(cell.sheet, { r0: cell.row, c0: cell.column, r1: cell.row, c1: cell.column }),
        )
      } else {
        existing.r0 = Math.min(existing.r0, cell.row)
        existing.c0 = Math.min(existing.c0, cell.column)
        existing.r1 = Math.max(existing.r1, cell.row)
        existing.c1 = Math.max(existing.c1, cell.column)
      }
    }
  })
  return {
    summary: summaryOf(
      null,
      [...touched.values()].map((rectangle) => rectangle.sheet),
      replaced.length,
      [...touched.values()],
    ),
    replaced,
    refused,
    truncated: found.truncated,
  }
}
