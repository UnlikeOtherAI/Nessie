import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { TodoProgressCardView } from '../src/components/features/channels/TodoProgressCard.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

test('a denied todo card renders only a neutral placeholder', () => {
  const html = renderToStaticMarkup(createElement(TodoProgressCardView, {
    todoId: '00000000-0000-0000-0000-000000000001',
    todo: undefined,
    unavailable: true,
  }))
  assert.match(html, /To-do details are unavailable\./)
  assert.doesNotMatch(html, /step|checklist|secret/i)
})
