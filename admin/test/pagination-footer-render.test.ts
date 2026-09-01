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
      label: 'Page 2',
      onPageChange: () => {},
      page: 1,
      ...props,
    }),
  )

test('the strip is Previous, then the label, then Next — in that order', () => {
  const markup = render()
  const previous = markup.indexOf('Previous')
  const label = markup.indexOf('Page 2')
  const next = markup.indexOf('Next')
  assert.ok(previous < label && label < next, markup)
})

// Both shipping call sites draw a rule above the strip and dim the label at the
// smaller scale; only the spacing differs, so only the spacing is a prop.
test('the top rule and the label treatment are not negotiable', () => {
  const markup = render()
  assert.match(markup, /flex items-center justify-between border-t border-\[color:var\(--sep\)\]/)
  assert.match(markup, /<span class="text-xs text-\[color:var\(--tx3\)\]">Page 2<\/span>/)
})

test('className carries the caller spacing and nothing else', () => {
  assert.match(render({ className: 'px-6 py-3' }), /border-\[color:var\(--sep\)\] px-6 py-3"/)
  assert.match(render({ className: 'pt-4' }), /border-\[color:var\(--sep\)\] pt-4"/)
  // No trailing separator when a call site passes no spacing at all.
  assert.match(render(), /border-\[color:var\(--sep\)\]"/)
})

test('each button is disabled by its own direction, independently', () => {
  const noPrevious = render({ canPrevious: false })
  assert.match(noPrevious, /disabled=""[^>]*>Previous/)
  assert.doesNotMatch(noPrevious, /disabled=""[^>]*>Next/)

  const noNext = render({ canNext: false })
  assert.match(noNext, /disabled=""[^>]*>Next/)
  assert.doesNotMatch(noNext, /disabled=""[^>]*>Previous/)
})

// `page` is handed back untouched so the strip never has to know whether the
// caller counts from zero (AgentsList, AgentDetailTabs) or one (a 1-based
// pager would work the same way). It only ever asks for the neighbour.
test('the strip asks for the neighbouring page in the caller own numbering', () => {
  const asked: number[] = []
  const props: Props = {
    canNext: true,
    canPrevious: true,
    label: 'Page 1',
    onPageChange: (next) => asked.push(next),
    page: 0,
  }
  const tree = PaginationFooter(props) as React.ReactElement<{ children: React.ReactNode }>
  const [previous, , next] = React.Children.toArray(
    tree.props.children,
  ) as React.ReactElement<{ onClick: () => void }>[]

  previous.props.onClick()
  next.props.onClick()
  assert.deepEqual(asked, [-1, 1])
})

// AgentDetailTabs shows the strip only when a neighbour exists, because it
// pages a server window and has no total to state; AgentsList always shows it,
// so the table above does not jump when a scope holds one page.
test('hiding on a single page is opt-in, and needs both directions closed', () => {
  assert.equal(render({ canNext: false, canPrevious: false, hideWhenSinglePage: true }), '')
  assert.match(render({ canNext: false, canPrevious: false }), /Previous/)
  assert.match(render({ canNext: true, canPrevious: false, hideWhenSinglePage: true }), /Next/)
  assert.match(render({ canNext: false, canPrevious: true, hideWhenSinglePage: true }), /Previous/)
})

// The two live labels say different things because the two call sites know
// different amounts. Neither is derivable from `page`, so neither is built here.
test('the label is the caller sentence, verbatim', () => {
  assert.match(render({ label: '1–10 of 34 · Page 1 of 4' }), />1–10 of 34 · Page 1 of 4</)
  assert.match(render({ label: 'No agents' }), />No agents</)
})
