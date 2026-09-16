import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  A1Schema,
  SPREADSHEET_LIMITS,
  SpreadsheetBatchSummarySchema,
  SpreadsheetPresenceFrameSchema,
  SpreadsheetSelectionSchema,
  columnIndexToLabel,
  columnLabelToIndex,
  formatA1Range,
  parseA1Range,
  presenceColorFor,
  selectionCellCount,
} from '../spreadsheet.js'

describe('A1 addressing', () => {
  it('round-trips column labels', () => {
    for (const [index, label] of [
      [1, 'A'],
      [26, 'Z'],
      [27, 'AA'],
      [52, 'AZ'],
      [702, 'ZZ'],
      [703, 'AAA'],
      [16_384, 'XFD'],
    ] as const) {
      assert.equal(columnIndexToLabel(index), label)
      assert.equal(columnLabelToIndex(label), index)
    }
  })

  it('parses cells and ranges, normalising reversed corners', () => {
    assert.deepEqual(parseA1Range('B2'), { r0: 2, c0: 2, r1: 2, c1: 2 })
    assert.deepEqual(parseA1Range('B2:D40'), { r0: 2, c0: 2, r1: 40, c1: 4 })
    assert.deepEqual(parseA1Range('D40:B2'), { r0: 2, c0: 2, r1: 40, c1: 4 })
    assert.deepEqual(parseA1Range('$B$2:$D$40'), { r0: 2, c0: 2, r1: 40, c1: 4 })
    assert.deepEqual(parseA1Range('b2:d40'), parseA1Range('B2:D40'))
  })

  it('formats back to the shortest form', () => {
    assert.equal(formatA1Range({ r0: 2, c0: 2, r1: 2, c1: 2 }), 'B2')
    assert.equal(formatA1Range({ r0: 2, c0: 2, r1: 40, c1: 4 }), 'B2:D40')
    assert.equal(formatA1Range(parseA1Range('AA10:AC12')), 'AA10:AC12')
  })

  it('refuses a sheet-qualified reference so a range cannot disagree with its sheet', () => {
    assert.equal(A1Schema.safeParse('Sheet1!B2').success, false)
    assert.throws(() => parseA1Range('Sheet1!B2'))
  })

  it('refuses nonsense', () => {
    for (const bad of ['', 'B', '2', 'B0', 'ZZZZ1', 'B2:', ':B2', 'B2:D40:F1']) {
      assert.equal(A1Schema.safeParse(bad).success, false, bad)
    }
    assert.throws(() => columnLabelToIndex('XFE'))
    assert.throws(() => columnIndexToLabel(0))
  })

  it('counts cells in a range', () => {
    assert.equal(selectionCellCount(parseA1Range('B2:D40')), 39 * 3)
    assert.equal(selectionCellCount(parseA1Range('A1')), 1)
  })
})

describe('selection', () => {
  it('requires normalised corners', () => {
    assert.equal(SpreadsheetSelectionSchema.safeParse({ r0: 5, c0: 1, r1: 2, c1: 3 }).success, false)
    assert.equal(SpreadsheetSelectionSchema.safeParse({ r0: 2, c0: 1, r1: 5, c1: 3 }).success, true)
  })
})

describe('presence', () => {
  it('gives an actor the same colour every time', () => {
    const id = '7b1d4f9e-0000-4000-8000-000000000001'
    assert.equal(presenceColorFor(id), presenceColorFor(id))
    assert.match(presenceColorFor(id), /^#[0-9a-f]{6}$/)
  })

  it('caps the draft at the wire limit', () => {
    const frame = {
      clientId: 'c1',
      sheet: 0,
      selection: { r0: 1, c0: 1, r1: 1, c1: 1 },
      cursor: { r: 1, c: 1 },
      draft: { r: 1, c: 1, text: 'x'.repeat(SPREADSHEET_LIMITS.maxDraftChars + 1) },
      ts: new Date().toISOString(),
    }
    assert.equal(SpreadsheetPresenceFrameSchema.safeParse(frame).success, false)
    frame.draft.text = 'x'.repeat(SPREADSHEET_LIMITS.maxDraftChars)
    assert.equal(SpreadsheetPresenceFrameSchema.safeParse(frame).success, true)
  })
})

describe('batch summary', () => {
  it('accepts a non-structural summary and a structural one', () => {
    const base = { structuralKind: null, sheetIndexes: [0], cellCount: 3, touched: [] }
    assert.equal(SpreadsheetBatchSummarySchema.safeParse(base).success, true)
    assert.equal(
      SpreadsheetBatchSummarySchema.safeParse({
        ...base,
        structuralKind: 'insertRows',
        intents: [{ kind: 'insertRows', sheet: 0, row: 5, count: 1 }],
      }).success,
      true,
    )
  })

  it('refuses an unknown structural kind and an over-long intent list', () => {
    const base = { structuralKind: 'mergeCells', sheetIndexes: [0], cellCount: 0, touched: [] }
    assert.equal(SpreadsheetBatchSummarySchema.safeParse(base).success, false)
    assert.equal(
      SpreadsheetBatchSummarySchema.safeParse({
        structuralKind: null,
        sheetIndexes: [0],
        cellCount: 0,
        touched: [],
        intents: Array.from({ length: SPREADSHEET_LIMITS.maxIntentsPerBatch + 1 }, () => ({
          kind: 'undo' as const,
        })),
      }).success,
      false,
    )
  })
})
