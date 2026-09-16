import { SPREADSHEET_ERROR_CODES, SPREADSHEET_MAX_COLUMNS, SPREADSHEET_MAX_ROWS, columnIndexToLabel } from '@nessie/schemas'

import { SpreadsheetEngineError } from './engine.js'

// Copy semantics, the way Excel and Google Sheets keep them: a formula moved by
// (dr, dc) has every *relative* reference shifted and every absolute (`$`) one
// kept. We do not re-parse the formula ourselves — IronCalc's own `getTokens`
// lexer marks each Reference and Range token with its `start`/`end` char
// offsets, so only those spans are spliced and a string, a name or a function
// call can never be corrupted.
//
// The rules below are not guesses: each is a measurement of the engine's own
// `copyToClipboard` + `pasteFromClipboard(…, false)` on @ironcalc/wasm 0.8.4,
// and `test/formula-shift.test.ts` re-measures all of them on every run.
//
//  - a reference whose shifted row is < 1, or whose shifted column is outside
//    1…16384, becomes `#REF!` — and the sheet prefix goes with it;
//  - rows are NOT bounded above: `A1048576` shifted down one becomes
//    `A1048577`, not `#REF!`. Only columns have an upper bound;
//  - a range's two endpoints fail independently: `=SUM(A1:XFD1)` shifted one
//    column right is `=SUM(B1:#REF!)`;
//  - a range's sheet prefix is rendered with its LEFT endpoint, so a #REF! left
//    endpoint drops it (`=SUM(#REF!:B1)`) and a #REF! right one keeps it
//    (`=SUM(Sheet1!B1:#REF!)`);
//  - after shifting, a range whose endpoints crossed is re-normalised, and the
//    `$` travels with the coordinate it belongs to: `$A1:B$10` moved ten rows
//    down is `$A$10:B11`, not `$A11:B$10`;
//  - a whole column (`A:A`) is a Range with synthetic absolute rows 1…1048576
//    and a whole row (`1:3`) a Range with synthetic absolute columns 1…16384;
//    both are re-rendered in their short form.
//
// The one thing we deliberately do NOT reproduce is the engine's incidental
// re-printing of everything else: a paste of `= B5 * 2` comes back `=B5*2` and
// `=sum(a1:b2)` comes back `=SUM(A1:B2)`. Splicing leaves those spans alone.
// It does not matter in practice, because every formula we shift was read back
// out of the engine and is therefore already in the engine's own spelling —
// which is exactly how the fixture test feeds them.

export const REF_ERROR = '#REF!'

export interface ParsedReference {
  column: number
  row: number
  absolute_column: boolean
  absolute_row: boolean
}

export interface ReferenceToken {
  Reference: ParsedReference & { sheet?: string | null }
}

export interface RangeToken {
  Range: { sheet?: string | null; left: ParsedReference; right: ParsedReference }
}

export interface MarkedToken {
  token: unknown
  start: number
  end: number
}

export type FormulaTokenizer = (formula: string) => MarkedToken[]

let tokenizer: FormulaTokenizer | null = null

/**
 * `getTokens` lives in the wasm build only (the Node binding does not export
 * it), and the wasm build needs `initSync` before any export is callable. Both
 * entry points therefore register it once they have initialised: `node.ts`'s
 * `initFormulaTokenizer()` on the server, the pane's own init in the browser.
 */
export function setFormulaTokenizer(next: FormulaTokenizer | null): void {
  tokenizer = next
}

export function hasFormulaTokenizer(): boolean {
  return tokenizer !== null
}

export function formulaTokenizer(): FormulaTokenizer {
  if (!tokenizer) {
    throw new SpreadsheetEngineError(
      SPREADSHEET_ERROR_CODES.engineUnavailable,
      'the formula tokenizer is not registered; call initFormulaTokenizer() from @nessie/spreadsheet/node first',
    )
  }
  return tokenizer
}

export function isFormula(text: string): boolean {
  return typeof text === 'string' && text.startsWith('=')
}

function isReference(token: unknown): token is ReferenceToken {
  return typeof token === 'object' && token !== null && 'Reference' in token
}

function isRange(token: unknown): token is RangeToken {
  return typeof token === 'object' && token !== null && 'Range' in token
}

function isIllegal(token: unknown): boolean {
  if (token === 'Illegal') return true
  return typeof token === 'object' && token !== null && 'Illegal' in token
}

export interface TokenizeOptions {
  getTokens?: FormulaTokenizer
}

export function tokenizeFormula(formula: string, options: TokenizeOptions = {}): MarkedToken[] {
  return (options.getTokens ?? formulaTokenizer())(formula)
}

/** True when the engine's own lexer accepts the text as a formula. */
export function formulaParses(formula: string, options: TokenizeOptions = {}): boolean {
  try {
    return !tokenizeFormula(formula, options).some((marked) => isIllegal(marked.token))
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ shifting

const WHOLE_COLUMN_ROWS = { first: 1, last: SPREADSHEET_MAX_ROWS }
const WHOLE_ROW_COLUMNS = { first: 1, last: SPREADSHEET_MAX_COLUMNS }

function shiftOne(reference: ParsedReference, dr: number, dc: number): ParsedReference | null {
  const row = reference.absolute_row ? reference.row : reference.row + dr
  const column = reference.absolute_column ? reference.column : reference.column + dc
  // Measured: only the lower bound applies to rows; columns are bounded both ways.
  if (row < 1 || column < 1 || column > SPREADSHEET_MAX_COLUMNS) return null
  return { row, column, absolute_row: reference.absolute_row, absolute_column: reference.absolute_column }
}

function renderCell(reference: ParsedReference): string {
  const column = `${reference.absolute_column ? '$' : ''}${columnIndexToLabel(reference.column)}`
  return `${column}${reference.absolute_row ? '$' : ''}${reference.row}`
}

function renderColumnOnly(reference: ParsedReference): string {
  return `${reference.absolute_column ? '$' : ''}${columnIndexToLabel(reference.column)}`
}

function renderRowOnly(reference: ParsedReference): string {
  return `${reference.absolute_row ? '$' : ''}${reference.row}`
}

/** The literal sheet prefix as it was written, `Sheet2!` or `'My Sheet'!`. */
function sheetPrefix(raw: string, sheet: string | null | undefined): string {
  if (sheet === null || sheet === undefined) return ''
  const bang = raw.lastIndexOf('!')
  return bang === -1 ? '' : raw.slice(0, bang + 1)
}

function isWholeColumn(left: ParsedReference, right: ParsedReference): boolean {
  return (
    left.absolute_row &&
    right.absolute_row &&
    left.row === WHOLE_COLUMN_ROWS.first &&
    right.row === WHOLE_COLUMN_ROWS.last
  )
}

function isWholeRow(left: ParsedReference, right: ParsedReference): boolean {
  return (
    left.absolute_column &&
    right.absolute_column &&
    left.column === WHOLE_ROW_COLUMNS.first &&
    right.column === WHOLE_ROW_COLUMNS.last
  )
}

/** After a shift the corners can cross; the `$` travels with its coordinate. */
function normalise(left: ParsedReference, right: ParsedReference): [ParsedReference, ParsedReference] {
  let l = { ...left }
  let r = { ...right }
  if (l.row > r.row) {
    const row = l.row
    const absolute = l.absolute_row
    l = { ...l, row: r.row, absolute_row: r.absolute_row }
    r = { ...r, row, absolute_row: absolute }
  }
  if (l.column > r.column) {
    const column = l.column
    const absolute = l.absolute_column
    l = { ...l, column: r.column, absolute_column: r.absolute_column }
    r = { ...r, column, absolute_column: absolute }
  }
  return [l, r]
}

export interface ShiftFormulaOptions extends TokenizeOptions {
  dr: number
  dc: number
  /**
   * When given, a cross-sheet reference to a name that is not in the list
   * becomes `#REF!` — the Sheets behaviour after a tab is deleted. Matching is
   * case-insensitive. Omit it to leave every sheet prefix alone, which is what
   * the engine's own paste does.
   */
  sheetNames?: readonly string[]
}

function sheetIsGone(sheet: string | null | undefined, names: readonly string[] | undefined): boolean {
  if (!names || sheet === null || sheet === undefined) return false
  const folded = sheet.toLowerCase()
  return !names.some((name) => name.toLowerCase() === folded)
}

function shiftReferenceToken(token: ReferenceToken, raw: string, options: ShiftFormulaOptions): string {
  const reference = token.Reference
  if (sheetIsGone(reference.sheet, options.sheetNames)) return REF_ERROR
  const shifted = shiftOne(reference, options.dr, options.dc)
  if (!shifted) return REF_ERROR
  return `${sheetPrefix(raw, reference.sheet)}${renderCell(shifted)}`
}

function shiftRangeToken(token: RangeToken, raw: string, options: ShiftFormulaOptions): string {
  const { sheet, left, right } = token.Range
  if (sheetIsGone(sheet, options.sheetNames)) return `${REF_ERROR}:${REF_ERROR}`
  const wholeColumn = isWholeColumn(left, right)
  const wholeRow = !wholeColumn && isWholeRow(left, right)
  let shiftedLeft = shiftOne(left, options.dr, options.dc)
  let shiftedRight = shiftOne(right, options.dr, options.dc)
  if (shiftedLeft && shiftedRight) {
    ;[shiftedLeft, shiftedRight] = normalise(shiftedLeft, shiftedRight)
  }
  const render = wholeColumn ? renderColumnOnly : wholeRow ? renderRowOnly : renderCell
  const prefix = sheetPrefix(raw, sheet)
  const leftText = shiftedLeft ? `${prefix}${render(shiftedLeft)}` : REF_ERROR
  const rightText = shiftedRight ? render(shiftedRight) : REF_ERROR
  return `${leftText}:${rightText}`
}

/**
 * Rewrite `formula` as if it had been copied by (dr, dc). Non-formula text is
 * returned unchanged, and a formula the lexer refuses is returned unchanged
 * too — a cell we cannot read is a cell we must not rewrite.
 */
export function shiftFormula(formula: string, options: ShiftFormulaOptions): string {
  if (!isFormula(formula)) return formula
  if (options.dr === 0 && options.dc === 0 && !options.sheetNames) return formula
  let tokens: MarkedToken[]
  try {
    tokens = tokenizeFormula(formula, options)
  } catch {
    return formula
  }
  if (tokens.some((marked) => isIllegal(marked.token))) return formula

  const pieces: string[] = []
  let cursor = 0
  for (const marked of tokens) {
    if (!isReference(marked.token) && !isRange(marked.token)) continue
    if (marked.start < cursor || marked.end > formula.length || marked.end < marked.start) continue
    const raw = formula.slice(marked.start, marked.end)
    const replacement = isReference(marked.token)
      ? shiftReferenceToken(marked.token, raw, options)
      : shiftRangeToken(marked.token as RangeToken, raw, options)
    pieces.push(formula.slice(cursor, marked.start), replacement)
    cursor = marked.end
  }
  pieces.push(formula.slice(cursor))
  return pieces.join('')
}

/**
 * Rewrite every reference in `formula` that points into a sheet-level edit —
 * what an insert or delete does to the formulas that survive it. The engine
 * does this itself for its own `insertRows`/`deleteRows`, so this is only for
 * the moves we build ourselves (sort), where the engine sees ordinary
 * `setUserInput` calls and cannot know a row moved.
 */
export function shiftFormulaForMove(
  formula: string,
  fromRow: number,
  toRow: number,
  options: TokenizeOptions & { sheetNames?: readonly string[] } = {},
): string {
  return shiftFormula(formula, { ...options, dr: toRow - fromRow, dc: 0 })
}
