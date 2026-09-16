import type { SpreadsheetBatchSummary, SpreadsheetIntent, SpreadsheetSelection } from '@nessie/schemas'

import {
  remapSheetIndex,
  shiftIndex,
  structuralEditsFromSummary,
  type SpreadsheetStructuralEdit,
} from './filter.js'

// Intent replay after a structural refusal.
//
// A client cannot transform IronCalc's diff bytes, so when the server refuses
// its batch because somebody inserted a row underneath it, the client undoes
// its pending actions locally, applies the foreign batches, and re-issues the
// intents it recorded — with every row, column and sheet index moved through
// those foreign batches first. That last step is this file.
//
// The property the tests hold it to, for the cell-level intents: applying the
// foreign structural batch and then the shifted intent lands the workbook in
// the same place as applying the intent first and then the foreign batch.
// A deleted target is the one case with no shifted form, and it needs none:
// "write then delete" also leaves nothing behind.

export { structuralEditsFromSummary }
export type { SpreadsheetStructuralEdit }

/**
 * A move permutes indexes, and a rectangle is not closed under a permutation:
 * rows 3–5 with row 4 moved to row 9 are no longer one block, so there is no
 * single shifted rectangle to re-issue. Two cases still are exact — the range
 * misses the moved window entirely, or it sits wholly inside the moved block —
 * and anything else is refused. The client re-issues such an intent itself
 * (its cell-level intents, which always shift, are the normal path).
 */
function shiftSelectionThroughMove(
  range: SpreadsheetSelection,
  edit: Extract<SpreadsheetStructuralEdit, { kind: 'moveRows' | 'moveColumns' }>,
): SpreadsheetSelection | null {
  const rows = edit.kind === 'moveRows'
  const low = rows ? range.r0 : range.c0
  const high = rows ? range.r1 : range.c1
  const blockLow = edit.start
  const blockHigh = edit.start + edit.count - 1
  const windowLow = Math.min(blockLow, blockLow + edit.delta)
  const windowHigh = Math.max(blockHigh, blockHigh + edit.delta)
  if (edit.delta === 0 || high < windowLow || low > windowHigh) return range
  if (low >= blockLow && high <= blockHigh) {
    return rows
      ? { ...range, r0: low + edit.delta, r1: high + edit.delta }
      : { ...range, c0: low + edit.delta, c1: high + edit.delta }
  }
  return null
}

function shiftSelection(
  range: SpreadsheetSelection,
  edit: SpreadsheetStructuralEdit,
): SpreadsheetSelection | null {
  if (edit.kind === 'moveRows' || edit.kind === 'moveColumns') return shiftSelectionThroughMove(range, edit)
  const r0 = shiftIndex(range.r0, edit, 'row')
  const r1 = shiftIndex(range.r1, edit, 'row')
  const c0 = shiftIndex(range.c0, edit, 'column')
  const c1 = shiftIndex(range.c1, edit, 'column')
  // A bound inside a deletion collapses onto the deletion's edge; a range whose
  // every row or column was deleted has nothing left to address.
  const lowRow = r0 ?? (edit.kind === 'deleteRows' ? edit.row : null)
  const highRow = r1 ?? (edit.kind === 'deleteRows' ? edit.row - 1 : null)
  const lowColumn = c0 ?? (edit.kind === 'deleteColumns' ? edit.column : null)
  const highColumn = c1 ?? (edit.kind === 'deleteColumns' ? edit.column - 1 : null)
  if (lowRow === null || highRow === null || lowColumn === null || highColumn === null) return null
  if (highRow < lowRow || highColumn < lowColumn || lowRow < 1 || lowColumn < 1) return null
  return { r0: lowRow, c0: lowColumn, r1: highRow, c1: highColumn }
}

function shiftSheet(sheet: number, edit: SpreadsheetStructuralEdit): number | null {
  return remapSheetIndex(sheet, edit)
}

/** One intent through one structural edit. Null means the edit removed it. */
export function shiftIntentByEdit(
  intent: SpreadsheetIntent,
  edit: SpreadsheetStructuralEdit,
): SpreadsheetIntent | null {
  // `undo` / `redo` carry no address. The union member's `kind` is itself a
  // two-value enum, so a `kind ===` test cannot narrow it away; the property
  // test can.
  if (!('sheet' in intent)) return intent

  const sheet = shiftSheet(intent.sheet, edit)
  if (sheet === null) return null
  const sameSheet =
    edit.kind === 'addSheet' || edit.kind === 'deleteSheet' || edit.kind === 'moveSheet' ? false : edit.sheet === intent.sheet
  if (!sameSheet) return { ...intent, sheet }

  switch (intent.kind) {
    case 'setUserInput':
    case 'paste': {
      const row = shiftIndex(intent.row, edit, 'row')
      const column = shiftIndex(intent.column, edit, 'column')
      if (row === null || column === null) return null
      return { ...intent, sheet, row, column }
    }
    case 'updateRangeStyle':
    case 'rangeClearAll':
    case 'rangeClearContents':
    case 'rangeClearFormatting': {
      const range = shiftSelection(intent.range, edit)
      if (!range) return null
      return { ...intent, sheet, range }
    }
    case 'insertRows':
    case 'deleteRows': {
      const row = shiftIndex(intent.row, edit, 'row')
      if (row === null) return null
      return { ...intent, sheet, row }
    }
    case 'insertColumns':
    case 'deleteColumns': {
      const column = shiftIndex(intent.column, edit, 'column')
      if (column === null) return null
      return { ...intent, sheet, column }
    }
    case 'moveRows':
    case 'moveColumns': {
      const axis = intent.kind === 'moveRows' ? 'row' : 'column'
      const start = shiftIndex(intent.start, edit, axis)
      if (start === null) return null
      return { ...intent, sheet, start }
    }
    case 'setRowsHidden':
    case 'setColumnsHidden':
    case 'setRowsHeight':
    case 'setColumnsWidth': {
      const axis = intent.kind === 'setRowsHidden' || intent.kind === 'setRowsHeight' ? 'row' : 'column'
      const start = shiftIndex(intent.start, edit, axis)
      const end = shiftIndex(intent.end, edit, axis)
      if (start === null || end === null || end < start) return null
      return { ...intent, sheet, start, end }
    }
    case 'setFrozenRowsCount':
    case 'setFrozenColumnsCount':
      return { ...intent, sheet }
  }
}

/**
 * Move one recorded intent through the structural batches that beat it to the
 * server, oldest first. Null means the intent no longer has a target and the
 * client drops it.
 */
export function shiftIntent(
  intent: SpreadsheetIntent,
  foreignSummaries: readonly SpreadsheetBatchSummary[],
): SpreadsheetIntent | null {
  let current: SpreadsheetIntent | null = intent
  for (const summary of foreignSummaries) {
    for (const edit of structuralEditsFromSummary(summary)) {
      if (!current) return null
      current = shiftIntentByEdit(current, edit)
    }
  }
  return current
}

/** The whole recorded batch, with the intents the foreign edits destroyed dropped. */
export function shiftIntents(
  intents: readonly SpreadsheetIntent[],
  foreignSummaries: readonly SpreadsheetBatchSummary[],
): SpreadsheetIntent[] {
  const shifted: SpreadsheetIntent[] = []
  for (const intent of intents) {
    const next = shiftIntent(intent, foreignSummaries)
    if (next) shifted.push(next)
  }
  return shifted
}
