import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { SpreadsheetEngineError, type SpreadsheetEngineModel } from '../src/engine.js'
import { findInWorkbook, replaceInWorkbook } from '../src/find.js'
import { runPaused } from '../src/write.js'

import { nodeModel } from './support/engine.js'

async function workbook(): Promise<SpreadsheetEngineModel> {
  const model = await nodeModel('find')
  model.newSheet()
  model.renameSheet(1, 'Notes')
  runPaused(model, () => {
    model.setUserInput(0, 1, 1, 'North region')
    model.setUserInput(0, 1, 2, 'north')
    model.setUserInput(0, 2, 1, 'Northern')
    model.setUserInput(0, 2, 2, '12')
    model.setUserInput(0, 3, 1, '=SUM(B2:B2)')
    model.setUserInput(0, 3, 2, '=CONCATENATE("North"," ","x")')
    model.setUserInput(1, 1, 1, 'North again')
  })
  return model
}

describe('find', () => {
  let model: SpreadsheetEngineModel

  before(async () => {
    model = await workbook()
  })

  it('searches the whole workbook by default', () => {
    const result = findInWorkbook(model, { query: 'north' })
    assert.deepEqual(
      result.matches.map((match) => `${match.sheetName}!${match.a1}`),
      ['Sheet1!A1', 'Sheet1!B1', 'Sheet1!A2', 'Sheet1!B3', 'Notes!A1'],
    )
  })

  it('narrows to a sheet and to a range', () => {
    assert.deepEqual(
      findInWorkbook(model, { query: 'north', scope: { kind: 'sheet', sheet: 1 } }).matches.map((m) => m.a1),
      ['A1'],
    )
    assert.deepEqual(
      findInWorkbook(model, {
        query: 'north',
        scope: { kind: 'range', sheet: 0, range: { r0: 1, c0: 1, r1: 1, c1: 1 } },
      }).matches.map((m) => m.a1),
      ['A1'],
    )
  })

  it('honours matchCase and wholeCell', () => {
    assert.deepEqual(
      findInWorkbook(model, { query: 'North', matchCase: true, scope: { kind: 'sheet', sheet: 0 } }).matches.map(
        (m) => m.a1,
      ),
      ['A1', 'A2', 'B3'],
    )
    assert.deepEqual(
      findInWorkbook(model, { query: 'north', wholeCell: true, scope: { kind: 'sheet', sheet: 0 } }).matches.map(
        (m) => m.a1,
      ),
      ['B1'],
    )
  })

  it('searches formula text with inFormulas', () => {
    const values = findInWorkbook(model, { query: 'SUM', scope: { kind: 'sheet', sheet: 0 } })
    assert.deepEqual(values.matches, [])
    const formulas = findInWorkbook(model, { query: 'SUM', inFormulas: true, scope: { kind: 'sheet', sheet: 0 } })
    assert.deepEqual(formulas.matches.map((m) => m.a1), ['A3'])
  })

  it('supports a bounded regex and refuses a catastrophic one', () => {
    assert.deepEqual(
      findInWorkbook(model, { query: '^North\\w*$', regex: true, matchCase: true, scope: { kind: 'sheet', sheet: 0 } })
        .matches.map((m) => m.a1),
      ['A2'],
    )
    assert.throws(
      () => findInWorkbook(model, { query: '(a+)+b', regex: true }),
      (error: unknown) => error instanceof SpreadsheetEngineError && error.code === 'SPREADSHEET_UNSUPPORTED_FEATURE',
    )
    assert.throws(() => findInWorkbook(model, { query: '' }), SpreadsheetEngineError)
  })

  it('truncates past the match limit', () => {
    const result = findInWorkbook(model, { query: 'north', limit: 2 })
    assert.equal(result.matches.length, 2)
    assert.equal(result.truncated, true)
  })
})

describe('replace', () => {
  it('replaces in formatted values and reports what it wrote', async () => {
    const model = await workbook()
    const result = replaceInWorkbook(model, {
      query: 'North',
      replacement: 'South',
      matchCase: true,
      scope: { kind: 'sheet', sheet: 0 },
    })
    assert.deepEqual(
      result.replaced.map((cell) => [cell.a1, cell.after]),
      [
        ['A1', 'South region'],
        ['A2', 'Southern'],
        ['B3', 'South x'],
      ],
    )
    assert.equal(model.cellContent(0, 1, 1), 'South region')
    assert.equal(result.summary.cellCount, 3)
    assert.deepEqual(result.summary.touched, [{ sheet: 0, r0: 1, c0: 1, r1: 3, c1: 2 }])
    assert.deepEqual(result.refused, [])
  })

  it('replaces inside formula text when asked', async () => {
    const model = await workbook()
    replaceInWorkbook(model, {
      query: 'B2:B2',
      replacement: 'B1:B2',
      inFormulas: true,
      scope: { kind: 'sheet', sheet: 0 },
    })
    assert.equal(model.cellContent(0, 3, 1), '=SUM(B1:B2)')
  })

  it('refuses per cell when the replacement would corrupt a formula', async () => {
    const model = await workbook()
    const before = model.cellContent(0, 3, 1)
    const result = replaceInWorkbook(model, {
      query: 'SUM(',
      replacement: 'SUM(((',
      inFormulas: true,
      scope: { kind: 'sheet', sheet: 0 },
    })
    assert.deepEqual(result.replaced, [])
    assert.deepEqual(
      result.refused.map((cell) => [cell.a1, cell.reason]),
      [['A3', 'the replacement does not parse as a formula']],
    )
    assert.equal(model.cellContent(0, 3, 1), before, 'the refused cell was not partially applied')
  })

  it('lands the good cells even when one is refused', async () => {
    const model = await workbook()
    runPaused(model, () => {
      model.setUserInput(0, 4, 1, '=SUM(B2:B2)+1')
      model.setUserInput(0, 5, 1, 'SUM( as plain text')
    })
    const result = replaceInWorkbook(model, {
      query: 'SUM(',
      replacement: 'SUM((',
      inFormulas: true,
      scope: { kind: 'sheet', sheet: 0 },
    })
    assert.deepEqual(result.refused.map((cell) => cell.a1), ['A3', 'A4'])
    assert.deepEqual(result.replaced.map((cell) => cell.a1), ['A5'])
    assert.equal(model.cellContent(0, 5, 1), 'SUM(( as plain text')
  })
})
