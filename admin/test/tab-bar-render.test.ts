import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { TabBar } from '../src/components/primitives/TabBar.js'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const items = [
  { count: 0, label: 'Already contacted', value: 'contacted' },
  { count: 7, label: 'Prospects', value: 'prospects' },
]

const render = (props: Partial<Parameters<typeof TabBar<string>>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(TabBar<string>, {
      ariaLabel: 'Sections',
      items,
      onChange: () => undefined,
      value: 'contacted',
      ...props,
    }),
  )

test('a tab strip marks the selected item and links it to its panel', () => {
  const html = render({ idPrefix: 'demo' })
  assert.match(html, /role="tablist"/)
  assert.match(html, /aria-label="Sections"/)
  assert.match(html, /aria-controls="demo-tabpanel-contacted"/)
  assert.match(html, /id="demo-tab-contacted"/)
  assert.match(html, /aria-selected="true"[^>]*>[^<]*Already contacted/)
  assert.match(html, /aria-selected="false"[^>]*>[^<]*Prospects/)
})

test('counts render beside the label, as the design shows them', () => {
  const html = render()
  assert.match(html, /Already contacted<span class="tabbar-count">\(0\)<\/span>/)
  assert.match(html, /Prospects<span class="tabbar-count">\(7\)<\/span>/)
})

test('only the selected item is in the tab order — arrow keys reach the rest', () => {
  const html = render()
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1)
  assert.equal((html.match(/tabindex="-1"/g) ?? []).length, items.length - 1)
})

test('a filter strip announces itself as a radio group, never as tabs', () => {
  const html = render({ role: 'radiogroup' })
  assert.match(html, /role="radiogroup"/)
  assert.match(html, /role="radio"/)
  assert.match(html, /aria-checked="true"/)
  assert.doesNotMatch(html, /aria-selected=/)
})

test('the sliding pill is absent until the client has measured it', () => {
  // Server markup has no layout to measure, so painting a pill at offset 0
  // would flash it in the wrong place before hydration corrects it.
  assert.doesNotMatch(render(), /tabbar-indicator/)
})
