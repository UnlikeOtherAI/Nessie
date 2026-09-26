import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { FinderTreeView } from '../src/components/features/knowledge/finder/FinderTreeView'
import type { KnowledgePageRecord } from '../src/facades/knowledge/hooks'

test('Tree gives images and documents quiet outline glyphs beside folders', () => {
  // The node:test loader compiles test-only TSX through the classic runtime;
  // production uses Vite's automatic JSX runtime.
  ;(globalThis as typeof globalThis & { React: typeof React }).React = React
  const rows = [
    { id: 'image', kind: 'file', title: 'photo.png' },
    { id: 'pdf', kind: 'file', title: 'report.pdf' },
    { id: 'generic', kind: 'file', title: 'archive.unknown' },
    { id: 'document', kind: 'document', title: 'Notes' },
    { id: 'spreadsheet', kind: 'spreadsheet', title: 'Budget' },
  ] as KnowledgePageRecord[]
  const markup = renderToStaticMarkup(React.createElement(FinderTreeView, {
    onOpenPage: () => undefined,
    pagePath: [],
    rowsIn: (parentPageId) => parentPageId ? [] : rows,
  }))
  const document = new JSDOM(markup).window.document
  const row = (id: string) => document.querySelector(`[data-finder-row="${id}"]`)

  assert.ok(row('image')?.querySelector('svg.knowledge-tree-glyph[data-knowledge-file-glyph="image"]'))
  assert.ok(row('pdf')?.querySelector('svg.knowledge-tree-glyph[data-knowledge-file-glyph="document"]'))
  assert.ok(row('generic')?.querySelector('svg.knowledge-tree-glyph[data-knowledge-file-glyph="document"]'))
  assert.ok(row('document')?.querySelector('svg.knowledge-tree-glyph'))
  assert.ok(row('spreadsheet')?.querySelector('svg.knowledge-tree-glyph'))
  assert.notEqual(row('image')?.innerHTML, row('pdf')?.innerHTML)
  assert.notEqual(row('document')?.innerHTML, row('spreadsheet')?.innerHTML)
})
