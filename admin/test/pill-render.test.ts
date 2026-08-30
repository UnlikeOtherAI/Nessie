import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { Pill } from '../src/components/primitives/Pill.js'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const render = (props: Partial<Parameters<typeof Pill>[0]> = {}): string =>
  renderToStaticMarkup(createElement(Pill, { children: 'active', ...props }))

test('every tone pairs its soft background with its own text colour', () => {
  assert.match(render({ tone: 'accent' }), /bg-\[color:var\(--accent-soft\)\][^"]*text-\[color:var\(--thinking\)\]/)
  assert.match(render({ tone: 'danger' }), /bg-\[color:var\(--danger-soft\)\][^"]*text-\[color:var\(--danger-text\)\]/)
  assert.match(render({ tone: 'success' }), /bg-\[color:var\(--success-soft\)\][^"]*text-\[color:var\(--success-text\)\]/)
  assert.match(render({ tone: 'warning' }), /bg-\[color:var\(--warning-soft\)\][^"]*text-\[color:var\(--warning-text\)\]/)
})

test('a pill with no tone is muted', () => {
  assert.match(render(), /bg-\[color:var\(--overlay-weak\)\][^"]*text-\[color:var\(--tx3\)\]/)
})

test('the two sizes are the only padding and type scales on offer', () => {
  assert.match(render(), /px-2\.5 py-1 text-\[11px\]/)
  assert.match(render({ size: 'sm' }), /px-2 py-0\.5 text-\[10px\]/)
})

test('a pill is an inline chip whatever its tone or size', () => {
  for (const html of [render(), render({ size: 'sm', tone: 'danger' })]) {
    assert.match(html, /inline-flex items-center/)
  }
})

test('the two radii are the capsule and the 4px chip, capsule by default', () => {
  assert.match(render(), /\brounded-full\b/)
  assert.match(render({ radius: 'capsule' }), /\brounded-full\b/)
  const chip = render({ radius: 'chip' })
  assert.match(chip, /\brounded\b/)
  assert.doesNotMatch(chip, /\brounded-full\b/)
})

// Casing is one decision, not three: a shouted label needs the tracking to stay
// readable and the weight to survive being small, and a sentence-case chip that
// inherited either would render as wide-tracked bold prose it never had.
test('an uppercase pill carries the transform, the tracking and the weight', () => {
  const html = render()
  assert.match(html, /\buppercase\b/)
  assert.match(html, /\bfont-semibold\b/)
  assert.match(html, /tracking-\[0\.16em\]/)
})

test('a sentence-case pill carries none of the three', () => {
  const html = render({ uppercase: false })
  assert.doesNotMatch(html, /\buppercase\b/)
  assert.doesNotMatch(html, /\bfont-semibold\b/)
  assert.doesNotMatch(html, /\btracking-/)
})

test('a sentence-case caller can still ask for weight explicitly', () => {
  const html = render({ className: 'font-semibold', uppercase: false })
  assert.match(html, /\bfont-semibold\b/)
  assert.doesNotMatch(html, /\btracking-/)
})


