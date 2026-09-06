import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { BoardIcon } from '../src/components/features/projects/kanban/BoardIcon.js'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

/**
 * A board wears its own emoji, or the icon every board has always worn.
 *
 * The fallback is the point: `null` is by far the common case — every board
 * that existed before this field did — so a board with no emoji has to look
 * exactly like it did before, and the two have to occupy the same square or a
 * list of boards loses its straight left edge.
 */

test('a board with an emoji shows it instead of the default glyph', () => {
  const html = renderToStaticMarkup(createElement(BoardIcon, { iconEmoji: '🐛' }))

  assert.match(html, /🐛/)
  assert.doesNotMatch(html, /<svg/)
})

test('a board with no emoji keeps the shared board icon', () => {
  const html = renderToStaticMarkup(createElement(BoardIcon, { iconEmoji: null }))

  assert.match(html, /<svg/)
})

test('either way it is the same fixed square, so the names line up', () => {
  const emoji = renderToStaticMarkup(createElement(BoardIcon, { iconEmoji: '🐛' }))
  const fallback = renderToStaticMarkup(createElement(BoardIcon, { iconEmoji: null }))

  for (const html of [emoji, fallback]) {
    assert.match(html, /h-3\.5 w-3\.5/)
    assert.match(html, /flex-shrink-0/)
  }
})

test('the glyph is decoration — the row already carries the board name', () => {
  const html = renderToStaticMarkup(createElement(BoardIcon, { iconEmoji: '🐛' }))

  assert.match(html, /aria-hidden="true"/)
})
