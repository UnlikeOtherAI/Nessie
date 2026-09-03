import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'

// A behavioural test for the pull gesture itself: a real pull past the
// threshold must run the caller's content refresh (a React Query refetch of the
// visible page) and never reload the shell, and the spinner must stay pinned
// until that refetch settles. Source-string wiring is pinned in
// pull-to-refresh.test.ts; this drives the DOM listeners the hook installs.

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.nessie.works/' })

// Mark the page as the native React Native WebView shell — the only surface the
// hook arms on (`isReactNativeWebView`).
;(dom.window as unknown as { ReactNativeWebView: { postMessage: () => void } }).ReactNativeWebView = {
  postMessage: () => undefined,
}

const React = await import('react')
const { act, createElement: h, useRef } = React
const { createRoot } = await import('react-dom/client')
const { usePullToRefresh, PULL_THRESHOLD_PX } = await import('../src/navigation/pull-to-refresh.js')

// Applied per mount and restored after, because the suite runs every jsdom file
// in one process (`--experimental-test-isolation=none`): a sibling test that
// installs its own `window` would otherwise leave `isReactNativeWebView()`
// reading a shell without `ReactNativeWebView`.
const domGlobals = {
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  window: dom.window,
}

// A touch event jsdom does not model natively: dispatch a plain Event with a
// `touches` list the handlers read.
const touch = (type: string, clientY: number): Event => {
  const event = new dom.window.Event(type, { bubbles: true })
  Object.defineProperty(event, 'touches', { value: [{ clientY }] })
  return event
}

const mount = async () => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  let refreshCalls = 0
  let resolveRefresh: (() => void) | null = null
  const onRefresh = () => {
    refreshCalls += 1
    return new Promise<void>((resolve) => {
      resolveRefresh = resolve
    })
  }

  const Host = () => {
    const scrollerRef = useRef<HTMLDivElement | null>(null)
    const indicatorRef = useRef<HTMLDivElement | null>(null)
    usePullToRefresh({ enabled: true, indicatorRef, onRefresh, scrollerRef })
    return h(
      'div',
      null,
      h('div', { 'data-testid': 'indicator', ref: indicatorRef }),
      h('div', { 'data-testid': 'scroller', ref: scrollerRef }),
    )
  }

  await act(async () => {
    root.render(h(Host))
  })

  const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement
  const indicator = container.querySelector('[data-testid="indicator"]') as HTMLElement
  return {
    indicator,
    refreshCalls: () => refreshCalls,
    resolveRefresh: async () => {
      await act(async () => {
        resolveRefresh?.()
        await Promise.resolve()
      })
    },
    scroller,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

test('a pull past the threshold runs the content refresh and pins the spinner until it settles', async () => {
  const view = await mount()
  try {
    view.scroller.scrollTop = 0
    await act(async () => {
      view.scroller.dispatchEvent(touch('touchstart', 100))
      view.scroller.dispatchEvent(touch('touchmove', 100 + PULL_THRESHOLD_PX * 2))
      view.scroller.dispatchEvent(touch('touchend', 100 + PULL_THRESHOLD_PX * 2))
    })

    assert.equal(view.refreshCalls(), 1, 'the visible page data is refetched exactly once')
    assert.equal(view.indicator.dataset.refreshing, 'true', 'the spinner is pinned while the refetch runs')

    await view.resolveRefresh()
    assert.equal(view.indicator.dataset.refreshing, 'false', 'the spinner retracts when the refetch settles')
  } finally {
    await view.unmount()
  }
})

test('a pull that never crosses the threshold does not refresh', async () => {
  const view = await mount()
  try {
    view.scroller.scrollTop = 0
    await act(async () => {
      view.scroller.dispatchEvent(touch('touchstart', 100))
      view.scroller.dispatchEvent(touch('touchmove', 110))
      view.scroller.dispatchEvent(touch('touchend', 110))
    })

    assert.equal(view.refreshCalls(), 0, 'a short pull is a cancel, not a refresh')
    assert.notEqual(view.indicator.dataset.refreshing, 'true')
  } finally {
    await view.unmount()
  }
})
