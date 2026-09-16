import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://app.nessie.works/',
})

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { useStickToBottom } = await import('../src/hooks/useStickToBottom.js')

const resizeCallbacks: Array<() => void> = []

const domGlobals = {
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  ResizeObserver: class {
    constructor(callback: () => void) {
      resizeCallbacks.push(callback)
    }
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  },
  window: dom.window,
}

const withDom = async (run: () => Promise<void>): Promise<void> => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  try {
    await run()
  } finally {
    resizeCallbacks.length = 0
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

// A 1000px feed in a 600px scroller, sitting at its newest message.
const mountFeed = async () => {
  const mount = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(mount)
  const root = createRoot(mount)
  const Host = () => {
    const scroll = useStickToBottom('thread-1', true)
    return h(
      'div',
      { 'data-testid': 'scroller', ref: scroll.containerRef },
      h('div', { ref: scroll.contentRef }, h('article', { 'data-message-id': 'm1' }, 'Newest')),
    )
  }
  await act(async () => root.render(h(Host)))

  const scroller = mount.querySelector('[data-testid="scroller"]') as HTMLElement
  const geometry = { clientHeight: 600, scrollHeight: 1_000, scrollTop: 400 }
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, get: () => geometry.clientHeight },
    scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => geometry.scrollTop,
      set: (value: number) => {
        geometry.scrollTop = Math.min(value, geometry.scrollHeight - geometry.clientHeight)
      },
    },
  })
  // The effect captured scrollTop before the geometry existed; one scroll at
  // the bottom brings its bookkeeping in line, as a real first paint would.
  await act(async () => scroller.dispatchEvent(new dom.window.Event('scroll')))

  const resize = async () => {
    await act(async () => {
      for (const callback of resizeCallbacks) callback()
    })
  }
  const unmount = async () => {
    await act(async () => root.unmount())
    mount.remove()
  }
  return { geometry, resize, scroller, unmount }
}

test('a keyboard shrinking the feed keeps the newest message in view', async () => {
  await withDom(async () => {
    const feed = await mountFeed()
    try {
      // iOS: the soft keyboard shrinks the scroller and its native scroll view
      // reports a scroll with an unchanged scrollTop before the resize lands.
      feed.geometry.clientHeight = 264
      await act(async () => feed.scroller.dispatchEvent(new dom.window.Event('scroll')))
      await feed.resize()

      assert.equal(
        feed.geometry.scrollTop,
        feed.geometry.scrollHeight - feed.geometry.clientHeight,
        'the feed re-pins to its newest message after the keyboard opens',
      )
    } finally {
      await feed.unmount()
    }
  })
})

test('a reader who scrolled up stays where they are when the feed resizes', async () => {
  await withDom(async () => {
    const feed = await mountFeed()
    try {
      feed.geometry.scrollTop = 100
      await act(async () => feed.scroller.dispatchEvent(new dom.window.Event('scroll')))
      feed.geometry.clientHeight = 264
      await act(async () => feed.scroller.dispatchEvent(new dom.window.Event('scroll')))
      await feed.resize()

      assert.equal(feed.geometry.scrollTop, 100, 'reading history is never yanked to the bottom')
    } finally {
      await feed.unmount()
    }
  })
})
