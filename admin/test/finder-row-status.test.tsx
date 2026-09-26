import assert from 'node:assert/strict'
import { before, test } from 'node:test'

import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FinderRow } from '../src/components/features/knowledge/finder/FinderRow'
import { initializeLocalization } from '../src/i18n/i18n'

before(async () => {
  await initializeLocalization()
})

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const renderRow = (
  status: 'draft' | 'published' | 'archived',
  grid = false,
  kind: 'document' | 'file' | 'spreadsheet' = 'document',
): string =>
  renderToStaticMarkup(
    <FinderRow
      gridCells={grid ? <span>Document</span> : undefined}
      gridTemplate={grid ? '20px minmax(200px, 1fr) 160px 16px' : undefined}
      id="page-1"
      kind={kind}
      status={status}
      title="Project plan"
      variant="item"
    />,
  )

test('a draft is visibly marked in the shared Finder row, including grid layout', () => {
  for (const grid of [false, true]) {
    const markup = renderRow('draft', grid)
    assert.match(markup, />Draft</)
    assert.match(markup, /Draft — not published/)
  }
})

test('published and archived Finder rows do not carry a misleading Draft badge', () => {
  for (const status of ['published', 'archived'] as const) {
    assert.doesNotMatch(renderRow(status), />Draft</)
  }
})

test('uploaded file rows do not call their default status a Draft', () => {
  assert.doesNotMatch(renderRow('draft', false, 'file'), />Draft</)
  assert.doesNotMatch(renderRow('draft', false, 'file'), /Draft — not published/)
})

test('draft badges remain available for publishable documents and spreadsheets', () => {
  for (const kind of ['document', 'spreadsheet'] as const) {
    assert.match(renderRow('draft', false, kind), />Draft</)
  }
})
