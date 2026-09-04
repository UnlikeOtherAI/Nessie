import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://app.nessie.works/',
})

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { HISTORY_TOP_THRESHOLD_PX, useStickToBottom } = await import(
  '../src/hooks/useStickToBottom.js'
)

const domGlobals = {
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  ResizeObserver: class {
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  },
  window: dom.window,
}

test('top-edge history loading is single-flight and preserves the visible message', async () => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  const mount = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(mount)
  const root = createRoot(mount)
  let loadCalls = 0
  const loadMore = async () => {
    loadCalls += 1
  }
  let retryOlder = () => {}

  const Host = ({
    failed,
    hasMore,
    itemCount,
    isLoading,
    pageCount,
  }: {
    failed: boolean
    hasMore: boolean
    itemCount: number
    isLoading: boolean
    pageCount: number
  }) => {
    const scroll = useStickToBottom('thread-1', true, {
      failed,
      hasMore,
      isLoading,
      itemCount,
      loadMore,
      pageCount,
    })
    retryOlder = scroll.loadOlder
    return h(
      'div',
      { 'data-testid': 'scroller', ref: scroll.containerRef },
      h(
        'div',
        { ref: scroll.contentRef },
        h('article', { 'data-message-id': 'anchor' }, 'Anchor message'),
      ),
    )
  }

  try {
    await act(async () => root.render(h(Host, {
      failed: false,
      hasMore: false,
      isLoading: false,
      itemCount: 50,
      pageCount: 1,
    })))
    const scroller = mount.querySelector('[data-testid="scroller"]') as HTMLElement
    const anchor = mount.querySelector('[data-message-id="anchor"]') as HTMLElement
    let scrollHeight = 1_000
    let scrollTop = 800
    let anchorTop = 20
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 200 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value },
      },
    })
    scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
    anchor.getBoundingClientRect = () => ({ top: anchorTop }) as DOMRect

    scrollTop = 0
    await act(async () => root.render(h(Host, {
      failed: false,
      hasMore: true,
      isLoading: false,
      itemCount: 50,
      pageCount: 1,
    })))
    assert.equal(loadCalls, 0, 'an overflowing first page waits for the reader to scroll')
    scrollTop = HISTORY_TOP_THRESHOLD_PX
    await act(async () => {
      scroller.dispatchEvent(new dom.window.Event('scroll'))
      scroller.dispatchEvent(new dom.window.Event('scroll'))
    })
    assert.equal(loadCalls, 1, 'one top-edge gesture starts only one page request')

    await act(async () => root.render(h(Host, {
      failed: false,
      hasMore: true,
      isLoading: true,
      itemCount: 50,
      pageCount: 1,
    })))
    scrollHeight = 1_500
    anchorTop = 520
    await act(async () => root.render(h(Host, {
      failed: false,
      hasMore: true,
      isLoading: false,
      itemCount: 100,
      pageCount: 2,
    })))

    assert.equal(scrollTop, 660, 'the existing anchor stays at the same viewport offset')

    scrollTop = 0
    await act(async () => root.render(h(Host, {
      failed: true,
      hasMore: true,
      isLoading: false,
      itemCount: 100,
      pageCount: 2,
    })))
    await act(async () => scroller.dispatchEvent(new dom.window.Event('scroll')))
    assert.equal(loadCalls, 1, 'a failed page settles until the reader explicitly retries')
    await act(async () => retryOlder())
    assert.equal(loadCalls, 2, 'the inline Retry action can start a fresh request')
  } finally {
    await act(async () => root.unmount())
    mount.remove()
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
