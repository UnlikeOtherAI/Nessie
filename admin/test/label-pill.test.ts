import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { LabelPill } from '../src/components/primitives/LabelPill.js'

const render = (props: Parameters<typeof LabelPill>[0]) => renderToStaticMarkup(createElement(LabelPill, props))

const classesOf = (html: string): string[] =>
  [...html.matchAll(/class="([^"]*)"/g)].map((match) => match[1] ?? '')

test('a label’s colour rides in as the inline --label property', () => {
  const html = render({ color: '#ef4444', name: 'Bug' })
  assert.match(html, /style="--label:#ef4444"/)
  assert.match(html, /class="admin-label-pill admin-label-pill-md"/)
  assert.match(html, />Bug</)
})

test('no class ever carries the hex — colour is data, never a utility', () => {
  const html = render({ color: '#3b82f6', name: 'Frontend', onRemove: () => undefined, size: 'sm' })
  for (const className of classesOf(html)) {
    assert.doesNotMatch(className, /#|[0-9a-f]{6}/i, `class "${className}" carries a colour`)
  }
})

test('the stylesheet mixes --label into theme tokens and keeps the text on --tx', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  const rule = css.match(/\.admin-label-pill \{[^}]*\}/)?.[0] ?? ''
  assert.match(rule, /background: color-mix\(in srgb, var\(--label\) 16%, var\(--panel\)\)/)
  assert.match(rule, /border: 1px solid color-mix\(in srgb, var\(--label\) 40%, transparent\)/)
  assert.match(rule, /color: var\(--tx\);/)
})

test('anything but a #rrggbb colour is not painted at all', () => {
  const html = render({ color: 'red; background:url(x)', name: 'Odd' })
  assert.doesNotMatch(html, /style=/)
})

test('the remove button is named for the label; without onRemove there is none', () => {
  assert.match(render({ color: '#22c55e', name: 'Done', onRemove: () => undefined }), /aria-label="Remove Done"/)
  assert.doesNotMatch(render({ color: '#22c55e', name: 'Done' }), /<button/)
})

test('a source-owned label shows its glyph and title', () => {
  const html = render({ color: '#6366f1', external: true, name: 'Linear', title: 'Linear owns this label' })
  assert.match(html, /data-external="true"/)
  assert.match(html, /class="admin-label-pill-glyph"/)
  assert.match(html, /title="Linear owns this label"/)
})
