import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import * as ReactNamespace from 'react'

import {
  findLinkedSidePanel,
  registerSidePanel,
  resizeSidePanelPair,
  resolveLinkedSidePanelWidths,
  SIDE_PANEL_MIN_WIDTH,
  useSidePanelGeometry,
  type SidePanelLink,
} from '../src/hooks/useSidePanelGeometry.js'

/**
 * Two side panels standing beside each other share one boundary.
 *
 * Each panel's drag handle is on its own left edge, so the handle between a
 * reply thread and the browser column belongs to the browser. Dragging it used
 * to widen the browser alone — the thread kept its width and slid sideways as
 * a block, which reads as the chat↔thread separator moving when the reader
 * grabbed the thread↔browser one. What is pinned here is the replacement: the
 * pair's total never changes, either clamp stops both, and a panel that is not
 * on screen is not linked to at all.
 */

;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const VIEWPORT = 1_600

test('a linked resize takes from the panel on the left exactly what it gives', () => {
  const moved = resolveLinkedSidePanelWidths(500, 500, 560, VIEWPORT)
  assert.deepEqual(moved, { width: 560, linkedWidth: 440 })

  const back = resolveLinkedSidePanelWidths(560, 440, 500, VIEWPORT)
  assert.deepEqual(back, { width: 500, linkedWidth: 500 })

  // The conversation beside the pair is the thing that must not move: its
  // width is whatever these two leave, so their total is the invariant.
  for (const requested of [320, 400, 640, 800, 5_000, -200]) {
    const result = resolveLinkedSidePanelWidths(500, 500, requested, VIEWPORT)
    assert.equal(result.width + result.linkedWidth, 1_000, `requested ${requested}`)
  }
})

test('whichever side reaches a bound first stops the pair', () => {
  // The left panel hits its 320px minimum 80px into a 200px pull.
  assert.deepEqual(
    resolveLinkedSidePanelWidths(500, 400, 700, VIEWPORT),
    { width: 580, linkedWidth: SIDE_PANEL_MIN_WIDTH },
  )
  // The dragged panel hits its own minimum going the other way.
  assert.deepEqual(
    resolveLinkedSidePanelWidths(400, 500, 200, VIEWPORT),
    { width: SIDE_PANEL_MIN_WIDTH, linkedWidth: 580 },
  )
  // ...and its own 50vw maximum, which the left panel has room to feed.
  assert.deepEqual(
    resolveLinkedSidePanelWidths(700, 700, 900, VIEWPORT),
    { width: 800, linkedWidth: 600 },
  )
  // Dragging further once a bound binds moves nothing, and dragging back
  // resumes from the bound rather than from where the pointer wandered to.
  assert.deepEqual(
    resolveLinkedSidePanelWidths(580, SIDE_PANEL_MIN_WIDTH, 900, VIEWPORT),
    { width: 580, linkedWidth: SIDE_PANEL_MIN_WIDTH },
  )
  assert.deepEqual(
    resolveLinkedSidePanelWidths(580, SIDE_PANEL_MIN_WIDTH, 540, VIEWPORT),
    { width: 540, linkedWidth: 360 },
  )
})

// A fake panel: the same three operations the hook publishes, over plain
// numbers and a storage map.
const fakePanel = (width: number, key: string, storage: Map<string, string>) => {
  const state = { width }
  return {
    link: {
      persistWidth: () => storage.set(key, String(state.width)),
      readWidth: () => state.width,
      setWidth: (next: number) => {
        state.width = next
      },
    } satisfies SidePanelLink,
    width: () => state.width,
  }
}

test('a linked gesture writes both panels’ preferences, an unlinked one only its own', () => {
  const storage = new Map<string, string>()
  const browser = fakePanel(500, 'browser', storage)
  const thread = fakePanel(500, 'thread', storage)

  resizeSidePanelPair(browser.link, thread.link, 560, VIEWPORT, false)
  assert.equal(browser.width(), 560)
  assert.equal(thread.width(), 440)
  assert.equal(storage.size, 0, 'mid-gesture moves the width, not the preference')

  // The keyboard path persists per step; so does the end of a drag.
  resizeSidePanelPair(browser.link, thread.link, 576, VIEWPORT, true)
  assert.deepEqual([...storage], [['browser', '576'], ['thread', '424']])

  const alone = fakePanel(500, 'alone', storage)
  resizeSidePanelPair(alone.link, null, 5_000, VIEWPORT, true)
  assert.equal(alone.width(), 800, 'an unlinked panel still clamps to 50vw')
  assert.equal(storage.get('alone'), '800')
})

test('a panel is linked to only while it is on screen', () => {
  const storage = new Map<string, string>()
  const thread = fakePanel(500, 'test.thread', storage)

  assert.equal(findLinkedSidePanel('test.thread'), null)
  assert.equal(findLinkedSidePanel(undefined), null, 'a panel with no neighbour never links')

  const unregister = registerSidePanel('test.thread', thread.link)
  assert.equal(findLinkedSidePanel('test.thread'), thread.link)

  // A remount registers the replacement before the outgoing effect cleans up;
  // the stale cleanup must not unlink the panel that is on screen.
  const remounted = fakePanel(500, 'test.thread', storage)
  const unregisterRemounted = registerSidePanel('test.thread', remounted.link)
  unregister()
  assert.equal(findLinkedSidePanel('test.thread'), remounted.link)

  unregisterRemounted()
  assert.equal(findLinkedSidePanel('test.thread'), null)
})

// ---------------------------------------------------------------------------
// The hooks themselves, in the arrangement that produced the bug: two
// geometries in unrelated components, linked by storage key alone.
// ---------------------------------------------------------------------------

const THREAD_KEY = 'test.linkedThreadPanelWidth'
const BROWSER_KEY = 'test.linkedBrowserPanelWidth'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/channels',
})
Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: VIEWPORT })

const domGlobals = {
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.window.navigator,
  window: dom.window,
}

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')

type Geometry = ReturnType<typeof useSidePanelGeometry>

const Panel = ({
  linkedLeftKey,
  isPresent,
  publish,
  storageKey,
}: {
  linkedLeftKey?: string
  isPresent?: boolean
  publish: (geometry: Geometry) => void
  storageKey: string
}) => {
  const geometry = useSidePanelGeometry(storageKey, { isPresent, linkedLeftKey })
  publish(geometry)
  return null
}

const mountPair = async () => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  dom.window.localStorage.setItem(THREAD_KEY, '500')
  dom.window.localStorage.setItem(BROWSER_KEY, '500')

  const geometries: Record<string, Geometry> = {}
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  const render = async (threadPresent: boolean) => {
    await act(async () => {
      root.render(
        h(
          React.Fragment,
          null,
          // The page's geometry runs whether or not a thread is open.
          h(Panel, {
            isPresent: threadPresent,
            key: 'thread',
            publish: (geometry: Geometry) => {
              geometries.thread = geometry
            },
            storageKey: THREAD_KEY,
          }),
          // The tool column names its left-hand neighbour unconditionally.
          h(Panel, {
            key: 'browser',
            linkedLeftKey: THREAD_KEY,
            publish: (geometry: Geometry) => {
              geometries.browser = geometry
            },
            storageKey: BROWSER_KEY,
          }),
        ),
      )
    })
  }

  await render(true)

  return {
    browser: () => geometries.browser,
    render,
    stored: (key: string) => dom.window.localStorage.getItem(key),
    thread: () => geometries.thread,
    unmount: async () => {
      await act(async () => root.unmount())
      container.remove()
      dom.window.localStorage.removeItem(THREAD_KEY)
      dom.window.localStorage.removeItem(BROWSER_KEY)
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

test('the handle between two open panels moves the boundary, not the pair', async () => {
  const pair = await mountPair()
  try {
    assert.equal(pair.thread().panelWidth, 500)
    assert.equal(pair.browser().panelWidth, 500)

    // One drag frame on the browser column's handle, pulled 60px left.
    await act(async () => pair.browser().resizePanel(560))
    assert.equal(pair.browser().panelWidth, 560)
    assert.equal(pair.thread().panelWidth, 440)

    await act(async () => pair.browser().persistPanelWidth())
    assert.equal(pair.stored(BROWSER_KEY), '560')
    assert.equal(pair.stored(THREAD_KEY), '440')

    // The thread's own handle still resizes it against the conversation.
    await act(async () => pair.thread().resizePanel(480))
    assert.equal(pair.thread().panelWidth, 480)
    assert.equal(pair.browser().panelWidth, 560)

    // Arrow keys on the shared separator move and persist both at once.
    await act(async () => pair.browser().resizePanelWithKeyboard(576))
    assert.equal(pair.browser().panelWidth, 576)
    assert.equal(pair.thread().panelWidth, 464)
    assert.equal(pair.stored(BROWSER_KEY), '576')
    assert.equal(pair.stored(THREAD_KEY), '464')
  } finally {
    await pair.unmount()
  }
})

test('with the thread closed the tool column resizes against the conversation alone', async () => {
  const pair = await mountPair()
  try {
    await pair.render(false)
    await act(async () => pair.browser().resizePanel(700))
    assert.equal(pair.browser().panelWidth, 700)
    assert.equal(pair.thread().panelWidth, 500, 'a closed panel owns no boundary')

    await act(async () => pair.browser().persistPanelWidth())
    assert.equal(pair.stored(BROWSER_KEY), '700')
    assert.equal(pair.stored(THREAD_KEY), '500', 'and its preference is left alone')
  } finally {
    await pair.unmount()
  }
})
