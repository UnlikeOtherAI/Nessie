import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { Notice } from '../src/components/primitives/Notice.js'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const render = (props: Partial<Parameters<typeof Notice>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(Notice, { children: 'Could not save', tone: 'danger', ...props }),
  )

test('every tone draws its own border, background and text triple', () => {
  assert.match(
    render({ tone: 'danger' }),
    /border-\[color:var\(--danger-border\)\] bg-\[color:var\(--danger-soft\)\] text-\[color:var\(--danger-text\)\]/,
  )
  assert.match(
    render({ tone: 'warning' }),
    /border-\[color:var\(--warning-border\)\] bg-\[color:var\(--warning-soft\)\] text-\[color:var\(--warning-text\)\]/,
  )
  assert.match(
    render({ tone: 'success' }),
    /border-\[color:var\(--success-border\)\] bg-\[color:var\(--success-soft\)\] text-\[color:var\(--success-text\)\]/,
  )
})

test('a notice is a bordered box at the snug padding unless told otherwise', () => {
  assert.match(render(), /border rounded-md px-3 py-2/)
  assert.match(render({ padding: 'lg' }), /rounded-md p-3/)
})

// Geometry has to be a prop: two radius utilities in one class string resolve
// by stylesheet source order, so a `className="rounded-xl"` layered over the
// built-in `rounded-md` is a coin flip rather than an override.
test('each shipped radius is reachable without a competing className', () => {
  assert.match(render({ radius: 'lg' }), /\brounded-lg\b/)
  assert.match(render({ radius: 'xl' }), /\brounded-xl\b/)
  assert.doesNotMatch(render({ radius: 'xl' }), /\brounded-md\b/)
})

test('the two sizes are the only type scales on offer', () => {
  assert.match(render(), /\btext-sm\b/)
  assert.match(render({ size: 'sm' }), /\btext-xs\b/)
})

// Every shipping banner is a block of its own, so the element is not a prop:
// an escape hatch to a paragraph would only be the seam a banner drifts
// through and loses the block semantics the layout around it assumes.
test('a notice is always a block', () => {
  assert.match(render(), /^<div /)
})

test('className reaches the element for the spacing and grid placement call sites pass', () => {
  assert.match(render({ className: 'mt-3 md:col-span-2' }), /mt-3 md:col-span-2/)
})

// The announcement has to land on the banner itself: a wrapper would name the
// wrong region, so a call site cannot bolt this on from outside.
test('a notice can announce itself, and stays silent unless asked to', () => {
  assert.match(render({ role: 'alert' }), /role="alert"/)
  assert.match(render({ role: 'status' }), /role="status"/)
  assert.doesNotMatch(render(), /\brole=/)
})

// Every notice is outlined. A borderless mode would be the seam through which
// the next unbordered banner drifts back in, so a call site that genuinely
// ships without a border (settings/push `PushResultBanner`) stays outside this
// primitive rather than being let through it.
test('the border is not optional', () => {
  for (const tone of ['danger', 'success', 'warning'] as const) {
    assert.match(render({ tone }), /(^|")border /)
  }
})
