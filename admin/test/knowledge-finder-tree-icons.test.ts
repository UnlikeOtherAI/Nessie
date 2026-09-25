import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { FinderTreeView } from '../src/components/features/knowledge/finder/FinderTreeView'
import type { KnowledgePageRecord } from '../src/facades/knowledge/hooks'

test('Tree gives images, other files, documents, and spreadsheets distinct glyphs', () => {
  const rows = [
    { id: 'image', kind: 'file', title: 'photo.png' },
    { id: 'pdf', kind: 'file', title: 'report.pdf' },
    { id: 'generic', kind: 'file', title: 'archive.unknown' },
    { id: 'document', kind: 'document', title: 'Notes' },
    { id: 'spreadsheet', kind: 'spreadsheet', title: 'Budget' },
  ] as KnowledgePageRecord[]
  const markup = renderToStaticMarkup(createElement(FinderTreeView, {
    onOpenPage: () => undefined,
    pagePath: [],
    rowsIn: (parentPageId) => parentPageId ? [] : rows,
  }))
  const document = new JSDOM(markup).window.document
  const row = (id: string) => document.querySelector(`[data-finder-row="${id}"]`)

  assert.equal(row('image')?.querySelector('svg[data-icon]')?.getAttribute('data-icon'), 'file-image')
  assert.equal(row('pdf')?.querySelector('svg[data-icon]')?.getAttribute('data-icon'), 'file-pdf')
  assert.equal(row('generic')?.querySelector('svg[data-icon]')?.getAttribute('data-icon'), 'file')
  assert.ok(row('document')?.querySelector('svg.knowledge-tree-glyph'))
  assert.ok(row('spreadsheet')?.querySelector('svg.knowledge-tree-glyph'))
  assert.notEqual(row('document')?.innerHTML, row('spreadsheet')?.innerHTML)
})
