import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FinderRow } from '../src/components/features/knowledge/finder/FinderRow'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const renderRow = (status: 'draft' | 'published' | 'archived', grid = false): string =>
  renderToStaticMarkup(
    <FinderRow
      gridCells={grid ? <span>Document</span> : undefined}
      gridTemplate={grid ? '20px minmax(200px, 1fr) 160px 16px' : undefined}
      id="page-1"
      kind="document"
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
