import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { CodeInput } from '../src/components/primitives/CodeInput.js'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const render = (props: Partial<Parameters<typeof CodeInput>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(CodeInput, {
      label: 'Pairing code',
      onChange: () => undefined,
      value: '',
      ...props,
    }),
  )

test('a code is one box per character', () => {
  const markup = render()
  assert.equal((markup.match(/<input/g) ?? []).length, 8)
})

test('each box says which position it is, so it is not eight unexplained fields', () => {
  const markup = render()
  assert.match(markup, /Pairing code, character 1 of 8/)
  assert.match(markup, /Pairing code, character 8 of 8/)
})

test('the value is spread one character per box', () => {
  const markup = render({ value: 'WXYZ2345' })
  // Each box carries exactly its own character.
  for (const character of 'WXYZ2345') {
    assert.match(markup, new RegExp(`value="${character}"`))
  }
})

test('a partial code leaves the remaining boxes empty rather than shifting', () => {
  const markup = render({ value: 'WX' })
  assert.equal((markup.match(/value=""/g) ?? []).length, 6)
})

test('the group is labelled once for assistive technology', () => {
  const markup = render()
  assert.match(markup, /role="group"/)
  // The visible boxes carry no repeated visual label; the group owns it.
  assert.match(markup, /class="sr-only"/)
})

test('only the first box offers one-time-code autofill', () => {
  // Case-insensitive: the static renderer emits the attribute camelCased, and
  // the assertion is about which box carries it, not how React spells it.
  const markup = render()
  assert.equal((markup.match(/autocomplete="one-time-code"/gi) ?? []).length, 1)
  assert.equal((markup.match(/autocomplete="off"/gi) ?? []).length, 7)
})
