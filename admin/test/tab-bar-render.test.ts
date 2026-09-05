import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

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

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

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

test('disabled choices are unavailable to radio-style strips', () => {
  const html = render({
    items: [
      { label: 'Ready', value: 'contacted' },
      { disabled: true, label: 'Unavailable', value: 'prospects' },
    ],
    role: 'radiogroup',
  })

  assert.match(html, /disabled=""[^>]*>Unavailable/)
})

test('every compact form selector reaches the shared sliding strip', () => {
  // Form-specific wrappers preserve their labels and submit behaviour, but they
  // may not grow a second compact selection visual. These are the former
  // button-row holdouts; cards with descriptive content are intentionally not
  // part of this list.
  const hosts: ReadonlyArray<readonly [string, string]> = [
    ['../src/components/shared/ChoiceGroup.tsx', '<TabBar'],
    ['../src/components/features/dashboards/AddWidgetPanel.tsx', '<ChoiceGroup'],
    ['../src/components/kanban/TaskDialog.tsx', '<TabBar'],
    ['../src/layouts/admin-shell/user-menu/PresenceControl.tsx', '<TabBar'],
    ['../src/components/features/integrations/BuildMeProjectPanel.tsx', '<ChoiceGroup'],
    ['../src/components/features/integrations/DeepTestSecurityPanel.tsx', '<ChoiceGroup'],
    ['../src/components/features/integrations/DeepWaterResearchCustomControls.tsx', '<ChoiceGroup'],
    ['../src/components/features/knowledge/VersionHistory.tsx', '<ChoiceGroup'],
    ['../src/pages/project/settings/BoardCreateDialog.tsx', '<ChoiceGroup'],
  ]

  for (const [file, expected] of hosts) {
    assert.ok(readSource(file).includes(expected), `${file} must use ${expected}`)
  }
})

test('the sliding pill is absent until the client has measured it', () => {
  // Server markup has no layout to measure, so painting a pill at offset 0
  // would flash it in the wrong place before hydration corrects it.
  assert.doesNotMatch(render(), /tabbar-indicator/)
})
