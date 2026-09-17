import type { SpreadsheetIntent } from '@nessie/schemas'

/**
 * The inverse of `intentFromCall`: re-issue a recorded intent against the
 * model, with whatever indexes `shiftIntent` moved it to.
 *
 * This is step (c) of rule 4. It calls the *real* engine methods, which means
 * the bridge records them again and their diffs land in the send queue — which
 * is exactly what is wanted: the replayed batch has to be a genuine batch, not
 * a re-labelled copy of the refused one's bytes.
 *
 * Declared against the narrowest interface that covers the calls rather than
 * against `Model`, so the unit test can hand it a recorder and assert the
 * shifted indexes without a wasm module.
 */
export type IntentTarget = {
  setUserInput: (sheet: number, row: number, column: number, value: string) => void
  updateRangeStyle: (
    area: { sheet: number; row: number; column: number; width: number; height: number },
    stylePath: string,
    value: string,
  ) => void
  rangeClearAll: (sheet: number, r0: number, c0: number, r1: number, c1: number) => void
  rangeClearContents: (sheet: number, r0: number, c0: number, r1: number, c1: number) => void
  rangeClearFormatting: (sheet: number, r0: number, c0: number, r1: number, c1: number) => void
  insertRows: (sheet: number, row: number, count: number) => void
  deleteRows: (sheet: number, row: number, count: number) => void
  insertColumns: (sheet: number, column: number, count: number) => void
  deleteColumns: (sheet: number, column: number, count: number) => void
  moveRows: (sheet: number, start: number, count: number, delta: number) => void
  moveColumns: (sheet: number, start: number, count: number, delta: number) => void
  setRowsHidden: (sheet: number, start: number, end: number, hidden: boolean) => void
  setColumnsHidden: (sheet: number, start: number, end: number, hidden: boolean) => void
  setRowsHeight: (sheet: number, start: number, end: number, size: number) => void
  setColumnsWidth: (sheet: number, start: number, end: number, size: number) => void
  setFrozenRowsCount: (sheet: number, count: number) => void
  setFrozenColumnsCount: (sheet: number, count: number) => void
}

/**
 * Re-issue one intent. Returns false for an intent with no replayable form,
 * which the caller counts as dropped — `paste` records that a paste happened
 * and not what it carried, and `undo`/`redo` address a stack the rollback has
 * already rewound.
 */
export const applyIntent = (target: IntentTarget, intent: SpreadsheetIntent): boolean => {
  switch (intent.kind) {
    case 'setUserInput':
      target.setUserInput(intent.sheet, intent.row, intent.column, intent.value)
      return true
    case 'updateRangeStyle':
      target.updateRangeStyle(
        {
          sheet: intent.sheet,
          row: intent.range.r0,
          column: intent.range.c0,
          width: intent.range.c1 - intent.range.c0 + 1,
          height: intent.range.r1 - intent.range.r0 + 1,
        },
        intent.stylePath,
        intent.value,
      )
      return true
    case 'rangeClearAll':
    case 'rangeClearContents':
    case 'rangeClearFormatting':
      target[intent.kind](
        intent.sheet,
        intent.range.r0,
        intent.range.c0,
        intent.range.r1,
        intent.range.c1,
      )
      return true
    case 'insertRows':
    case 'deleteRows':
      target[intent.kind](intent.sheet, intent.row, intent.count)
      return true
    case 'insertColumns':
    case 'deleteColumns':
      target[intent.kind](intent.sheet, intent.column, intent.count)
      return true
    case 'moveRows':
    case 'moveColumns':
      target[intent.kind](intent.sheet, intent.start, intent.count, intent.delta)
      return true
    case 'setRowsHidden':
    case 'setColumnsHidden':
      target[intent.kind](intent.sheet, intent.start, intent.end, intent.hidden)
      return true
    case 'setRowsHeight':
    case 'setColumnsWidth':
      target[intent.kind](intent.sheet, intent.start, intent.end, intent.size)
      return true
    case 'setFrozenRowsCount':
    case 'setFrozenColumnsCount':
      target[intent.kind](intent.sheet, intent.count)
      return true
    default:
      return false
  }
}

/** Every intent in order; returns how many were actually re-issued. */
export const applyIntents = (
  target: IntentTarget,
  intents: readonly SpreadsheetIntent[],
): number => {
  let applied = 0
  for (const intent of intents) if (applyIntent(target, intent)) applied += 1
  return applied
}
