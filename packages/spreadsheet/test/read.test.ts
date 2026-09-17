import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { SPREADSHEET_LIMITS } from '@nessie/schemas'

import { SpreadsheetEngineError, type SpreadsheetEngineModel } from '../src/engine.js'
import { describe as describeWorkbook, readHead, readRange, usedRange } from '../src/read.js'
import { createNodeModel } from '../src/node.js'

describe('read', () => {
  let model: SpreadsheetEngineModel

  before(() => {
    model = createNodeModel('read')
    model.pauseEvaluation()
    model.setUserInput(0, 1, 1, 'Item')
    model.setUserInput(0, 1, 2, 'Qty')
    model.setUserInput(0, 1, 3, 'Total')
    for (let row = 2; row <= 6; row++) {
      model.setUserInput(0, row, 1, `item ${row - 1}`)
      model.setUserInput(0, row, 2, String(row))
      model.setUserInput(0, row, 3, `=B${row}*10`)
    }
    model.newSheet()
    model.renameSheet(1, 'Notes')
    model.setUserInput(1, 3, 2, 'a note')
    model.setFrozenRowsCount(0, 1)
    model.resumeEvaluation()
    model.evaluate()
  })

  it('returns formatted values by default and formulas on request', () => {
    const values = readRange(model, 0, { r0: 2, c0: 2, r1: 3, c1: 3 })
    assert.deepEqual(values.values, [
      ['2', '20'],
      ['3', '30'],
    ])
    assert.equal(values.formulas, undefined)
    const both = readRange(model, 0, { r0: 2, c0: 3, r1: 3, c1: 3 }, { formulas: true, types: true })
    assert.deepEqual(both.formulas, [['=B2*10'], ['=B3*10']])
    assert.deepEqual(both.values, [['20'], ['30']])
    assert.deepEqual(both.types, [[1], [1]])
    assert.equal(both.a1, 'C2:C3')
  })

  it('refuses a read past maxCellsPerRead, and clamps when asked', () => {
    const huge = { r0: 1, c0: 1, r1: SPREADSHEET_LIMITS.maxCellsPerRead + 10, c1: 1 }
    assert.throws(
      () => readRange(model, 0, huge),
      (error: unknown) => error instanceof SpreadsheetEngineError && error.code === 'SPREADSHEET_TOO_LARGE',
    )
    const clamped = readRange(model, 0, huge, { clamp: true })
    assert.equal(clamped.truncated, true)
    assert.equal(clamped.rowCount, SPREADSHEET_LIMITS.maxCellsPerRead)
  })

  it('reports the used range, and null for an empty sheet', () => {
    assert.deepEqual(usedRange(model, 0), { r0: 1, c0: 1, r1: 6, c1: 3 })
    assert.deepEqual(usedRange(model, 1), { r0: 3, c0: 2, r1: 3, c1: 2 })
    const empty = createNodeModel('empty')
    assert.equal(usedRange(empty, 0), null)
  })

  it('describes every sheet with its used range and frozen panes', () => {
    const description = describeWorkbook(model)
    assert.equal(description.sheetCount, 2)
    assert.deepEqual(
      description.sheets.map((sheet) => [sheet.index, sheet.name, sheet.usedRangeA1, sheet.frozenRows]),
      [
        [0, 'Sheet1', 'A1:C6', 1],
        [1, 'Notes', 'B3', 0],
      ],
    )
    assert.equal(description.sheets[0]?.hidden, false)
  })

  it('reads a head without the caller working out a range first', () => {
    const head = readHead(model, 0, 2)
    assert.deepEqual(head?.values, [
      ['Item', 'Qty', 'Total'],
      ['item 1', '2', '20'],
    ])
    assert.equal(readHead(createNodeModel('empty'), 0), null)
  })

  it('reads 10 000 cells inside the budget', () => {
    const big = createNodeModel('big')
    big.pauseEvaluation()
    for (let row = 1; row <= 1000; row++) {
      for (let column = 1; column <= 10; column++) big.setUserInput(0, row, column, String(row * column))
    }
    big.resumeEvaluation()
    big.evaluate()
    const started = performance.now()
    const result = readRange(big, 0, { r0: 1, c0: 1, r1: 1000, c1: 10 }, { values: true, formulas: true })
    const elapsed = performance.now() - started
    assert.equal(result.values?.length, 1000)
    // eslint-disable-next-line no-console -- the acceptance criterion is a logged measurement
    console.log(`readRange 10 000 cells (values + formulas): ${elapsed.toFixed(1)} ms`)
    assert.ok(elapsed < 500, `readRange of 10 000 cells took ${elapsed.toFixed(1)} ms`)
  })
})
