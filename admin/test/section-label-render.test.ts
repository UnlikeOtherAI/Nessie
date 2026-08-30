import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { SectionLabel } from '../src/components/primitives/SectionLabel.js'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const render = (props: Partial<Parameters<typeof SectionLabel>[0]> = {}): string =>
  renderToStaticMarkup(createElement(SectionLabel, { children: 'Run limits', ...props }))

test('a section label is always the dim, spaced, uppercase heading treatment', () => {
  assert.match(render(), /font-semibold uppercase text-\[color:var\(--tx3\)\]/)
})

test('the two sizes are the only type and tracking scales on offer', () => {
  assert.match(render(), /text-xs tracking-\[0\.2em\]/)
  assert.match(render({ size: '2xs' }), /text-\[11px\] tracking-\[0\.18em\]/)
})

// The names have to survive a reader asking "which one is smaller?" without
// opening the file: `2xs` renders 11px and `xs` renders 12px, so the smaller
// name is the smaller label. An earlier pair called them `sm` and `xs` with
// `sm` the *smaller* of the two.
test('the smaller name renders the smaller label', () => {
  assert.match(render({ size: '2xs' }), /text-\[11px\]/)
  assert.match(render({ size: 'xs' }), /text-xs\b/)
})

// Three elements, because three are what ship: a plain block by default, a
// real `h2` where the label heads a section, and a `span` where it sits inline
// inside another block.
test('a label renders as a div until a call site needs real heading semantics', () => {
  assert.match(render(), /^<div /)
  assert.match(render({ as: 'h2' }), /^<h2 /)
  assert.match(render({ as: 'span' }), /^<span /)
})

test('className reaches the element for layout stragglers', () => {
  assert.match(render({ className: 'mb-2' }), /mb-2/)
})
