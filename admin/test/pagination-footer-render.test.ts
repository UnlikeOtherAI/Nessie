import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { PaginationFooter } from '../src/components/shared/PaginationFooter.js'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

type Props = Parameters<typeof PaginationFooter>[0]

const render = (props: Partial<Props> = {}): string =>
  renderToStaticMarkup(
    createElement(PaginationFooter, {
      canNext: true,
      canPrevious: true,
      label: '26–50 of 134',
      onPageChange: () => {},
      onPageSizeChange: () => {},
      page: 1,
      pageCount: 6,
      pageSize: 25,
      ...props,
    }),
  )

test('the strip states the current position between Previous and Next', () => {
  const markup = render()
  const previous = markup.indexOf('Previous')
  const position = markup.indexOf('Page 2 of 6')
  const next = markup.indexOf('Next')
  assert.ok(previous < position && position < next, markup)
})

test('the shared layout keeps its rule, range label, and responsive spacing', () => {
  const markup = render()
  assert.match(
    markup,
    /flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-\[color:var\(--sep\)\] py-3/,
  )
  assert.match(markup, /text-xs tabular-nums text-\[color:var\(--tx3\)\]">26–50 of 134<\/span>/)
  assert.match(render({ className: 'px-6' }), /border-\[color:var\(--sep\)\] py-3 px-6"/)
})

test('both navigation buttons retain independent disabled states', () => {
  const noPrevious = render({ canPrevious: false })
  assert.match(noPrevious, /disabled=""[^>]*>Previous/)
  assert.doesNotMatch(noPrevious, /disabled=""[^>]*>Next/)

  const noNext = render({ canNext: false })
  assert.match(noNext, /disabled=""[^>]*>Next/)
  assert.doesNotMatch(noNext, /disabled=""[^>]*>Previous/)
})

test('the controls use zero-based caller pages but speak one-based position', () => {
  const asked: number[] = []
  const tree = PaginationFooter({
    canNext: true,
    canPrevious: true,
    label: '1–25 of 134',
    onPageChange: (next) => asked.push(next),
    onPageSizeChange: () => {},
    page: 0,
    pageCount: 6,
    pageSize: 25,
  }) as React.ReactElement<{ children: React.ReactNode }>
  const [navigation] = React.Children.toArray(tree.props.children) as React.ReactElement<{
    children: React.ReactNode
  }>[]
  const [previous, , next] = React.Children.toArray(navigation.props.children) as React.ReactElement<{
    onClick: () => void
  }>[]

  previous.props.onClick()
  next.props.onClick()
  assert.deepEqual(asked, [-1, 1])
})

test('every pager has the one accessible Items per page picker', () => {
  const markup = render()
  assert.match(markup, /Items per page/)
  assert.match(markup, /aria-label="Items per page"/)
  for (const size of [10, 25, 50, 100]) {
    assert.match(markup, new RegExp(`<option value="${size}"`))
  }
  assert.match(markup, /<option value="25" selected="">25<\/option>/)
})

test('hiding on a single page is opt-in and uses the page count', () => {
  assert.equal(render({ hideWhenSinglePage: true, pageCount: 1 }), '')
  assert.match(render({ pageCount: 1 }), /Items per page/)
})
