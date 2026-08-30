import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { QueryState } from '../src/components/shared/QueryState.js'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

type Props = Parameters<typeof QueryState>[0]

const query = (state: Partial<Props['query']> = {}): Props['query'] => ({
  isError: false,
  isLoading: false,
  refetch: () => undefined,
  ...state,
})

const render = (props: Partial<Props> = {}): string =>
  renderToStaticMarkup(
    createElement(QueryState, {
      children: () => createElement('ul', null, 'the list'),
      errorLabel: 'Failed to load tools.',
      loadingLabel: 'Loading tools…',
      query: query(),
      ...props,
    }),
  )

// The three states are one geometry and two tones. Every page spelled these by
// hand and they had drifted apart; the classes below are the whole contract.
test('the loading line is the caller sentence at the one geometry', () => {
  assert.equal(
    render({ query: query({ isLoading: true }) }),
    '<div class="py-8 text-center text-sm text-[color:var(--tx3)]">Loading tools…</div>',
  )
})

test('the error block is the danger tone plus a Retry', () => {
  assert.equal(
    render({ query: query({ isError: true }) }),
    '<div class="py-8 text-center text-sm text-[color:var(--danger-text)]">'
    + 'Failed to load tools. <button class="underline" type="button">Retry</button></div>',
  )
})

test('the empty line reuses the loading geometry and tone', () => {
  assert.equal(
    render({ emptyLabel: 'No integrations registered.', isEmpty: true }),
    '<div class="py-8 text-center text-sm text-[color:var(--tx3)]">No integrations registered.</div>',
  )
})

// The whole reason this is a component and not a convention: a failed fetch
// and an empty list are different facts, and only one of them has a way out.
test('Retry calls the query own refetch, and nothing else does', () => {
  let refetched = 0
  const source = query({ isError: true, refetch: () => { refetched += 1 } })
  const tree = QueryState({
    children: () => null,
    errorLabel: 'Failed to load tools.',
    loadingLabel: 'Loading tools…',
    query: source,
  }) as React.ReactElement<{ children: React.ReactNode }>

  const button = React.Children.toArray(tree.props.children).find(
    (child): child is React.ReactElement<{ onClick: () => void }> =>
      React.isValidElement(child) && child.type === 'button',
  )
  assert.ok(button, 'the error block carries a Retry button')
  button.props.onClick()
  assert.equal(refetched, 1)

  // The loading and empty lines are plain text — no button to press.
  assert.doesNotMatch(render({ query: query({ isLoading: true }) }), /<button/)
  assert.doesNotMatch(render({ emptyLabel: 'Nothing yet.', isEmpty: true }), /<button/)
})

/**
 * `children` is a function so it runs only after the fetch has succeeded. The
 * inline triads it replaces all had to build their body eagerly, which is why
 * every one of them carried a `?? []` guard purely to survive the loading
 * render.
 */
test('the body is not built until the query has succeeded', () => {
  let built = 0
  const body = () => {
    built += 1
    return createElement('ul', null, 'the list')
  }

  render({ children: body, query: query({ isLoading: true }) })
  render({ children: body, query: query({ isError: true }) })
  render({ children: body, emptyLabel: 'Nothing yet.', isEmpty: true })
  assert.equal(built, 0)

  assert.match(render({ children: body }), /the list/)
  assert.equal(built, 1)
})

// ToolsPage passes no `emptyLabel`: ToolList tells "no tools at all" apart from
// "none match the filter", and this component cannot. An empty flag with no
// label must therefore fall through to the body, not blank the surface.
test('an empty flag with no label renders the body', () => {
  assert.match(render({ isEmpty: true }), /the list/)
})

// A surface can only be in one state, and the order is what a reader expects:
// a fetch that is still running is not yet an error, and a failed fetch is not
// an empty list.
test('loading wins over error, and error wins over empty', () => {
  const both = render({
    emptyLabel: 'Nothing yet.',
    isEmpty: true,
    query: query({ isError: true, isLoading: true }),
  })
  assert.match(both, /Loading tools…/)

  const failed = render({
    emptyLabel: 'Nothing yet.',
    isEmpty: true,
    query: query({ isError: true }),
  })
  assert.match(failed, /Failed to load tools\./)
  assert.doesNotMatch(failed, /Nothing yet\./)
})

/**
 * Padding is the caller's, deliberately. `py-8` in a list column and `py-6` in
 * the ToolsPage access panel — which swaps with two panels whose own empty
 * line is `py-6` — are two correct answers, and forcing one would misalign a
 * state against the thing it replaces. Everything else is fixed.
 */
test('className carries the vertical rhythm and nothing else', () => {
  const dense = render({ className: 'py-6', query: query({ isLoading: true }) })
  assert.equal(
    dense,
    '<div class="py-6 text-center text-sm text-[color:var(--tx3)]">Loading tools…</div>',
  )
  assert.match(
    render({ className: 'py-6', query: query({ isError: true }) }),
    /^<div class="py-6 text-center text-sm text-\[color:var\(--danger-text\)\]">/,
  )
})

// Both spellings compile to `color: var(--tx3)`; the pages disagreed only in
// how they wrote it. One spelling now, so a grep for the token finds every use.
test('the colour token is written the one way', () => {
  const markup = [
    render({ query: query({ isLoading: true }) }),
    render({ query: query({ isError: true }) }),
    render({ emptyLabel: 'Nothing yet.', isEmpty: true }),
  ].join('')
  assert.doesNotMatch(markup, /\[var\(--/)
  assert.match(markup, /\[color:var\(--tx3\)\]/)
  assert.match(markup, /\[color:var\(--danger-text\)\]/)
})
