import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import type { SpreadsheetEngineModel } from '../src/engine.js'
import { createNodeModel, loadNodeModel } from '../src/node.js'
import { projectSheet, projectWorkbook } from '../src/projection.js'
import { runPaused } from '../src/write.js'

function build(name: string): SpreadsheetEngineModel {
  const model = createNodeModel(name)
  runPaused(model, () => {
    model.setUserInput(0, 1, 1, 'Item')
    model.setUserInput(0, 1, 2, 'Qty')
    model.setUserInput(0, 1, 3, 'Total')
    model.setUserInput(0, 2, 1, 'pear')
    model.setUserInput(0, 2, 2, '3')
    model.setUserInput(0, 2, 3, '=B2*10')
    model.setUserInput(0, 4, 1, 'note\twith\ttabs')
    model.newSheet()
    model.renameSheet(1, 'Empty')
  })
  return model
}

describe('projection', () => {
  it('renders sheets, a header line and formatted values', () => {
    const text = projectWorkbook(build('p'), { title: 'Stock' })
    assert.equal(
      text,
      ['# Stock', '', '## Sheet1', 'A\tB\tC', 'Item\tQty\tTotal', 'pear\t3\t30', 'note with tabs', '', '## Empty', '(empty)'].join('\n'),
    )
  })

  it('is byte-stable across models, processes and a bytes round trip', () => {
    const first = projectWorkbook(build('a'), { title: 'Stock' })
    const second = projectWorkbook(build('b'), { title: 'Stock' })
    assert.equal(first, second)
    const reloaded = projectWorkbook(loadNodeModel(build('c').toBytes()), { title: 'Stock' })
    assert.equal(reloaded, first)
    assert.equal(
      createHash('sha256').update(first).digest('hex'),
      createHash('sha256').update(second).digest('hex'),
    )
  })

  it('skips wholly empty rows and trailing empty cells', () => {
    const model = createNodeModel('sparse')
    runPaused(model, () => {
      model.setUserInput(0, 1, 1, 'a')
      model.setUserInput(0, 1, 5, 'b')
      model.setUserInput(0, 5, 1, 'c')
    })
    assert.equal(projectWorkbook(model), ['## Sheet1', 'A\tB\tC\tD\tE', 'a\t\t\t\tb', 'c'].join('\n'))
  })

  it('truncates by rows and by characters, and says so', () => {
    const model = createNodeModel('long')
    runPaused(model, () => {
      for (let row = 1; row <= 40; row++) model.setUserInput(0, row, 1, `row ${row}`)
    })
    assert.match(projectWorkbook(model, { maxRowsPerSheet: 5 }), /\(35 more row\(s\) not shown\)/)
    assert.match(projectWorkbook(model, { maxChars: 40 }), /\(projection truncated\)/)
  })

  it('projects one sheet on its own', () => {
    assert.equal(projectSheet(build('single'), 1), '## Empty\n(empty)')
    assert.match(projectSheet(build('single'), 0), /^## Sheet1\n/)
  })
})
