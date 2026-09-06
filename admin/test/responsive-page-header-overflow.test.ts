import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'

/**
 * 06-F8: the overflow-measurement engine behind `ResponsivePageHeader` moved
 * into `useResponsivePageHeaderOverflow`, a hook with no JSX of its own. This
 * is the wiring check the audit asked for — the component had no render test
 * before the split — verifying end to end, on a real (if synthetic) DOM, that
 * a header narrower than its actions still collapses the low-priority ones
 * into "More" after the extraction.
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://app.nessie.works/',
})

// Every measured node in the header's hidden intrinsic row is a direct child
// of the `aria-hidden="true"` measurement container: index 0 is the leading
// lane, the next `actions.length` are the actions in prop order, and the last
// is the "More" trigger. Faking widths by position lets the test drive the
// same `getBoundingClientRect` calls the real hook makes without reaching
// into its internals.
const MORE_WIDTH = 30
const ACTION_WIDTH = 40
dom.window.Element.prototype.getBoundingClientRect = function (this: Element) {
  const rect = {
    bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0,
    toJSON() { return this },
  }
  const parent = this.parentElement
  if (parent?.getAttribute('aria-hidden') === 'true') {
    const siblings = Array.from(parent.children)
    const index = siblings.indexOf(this)
    if (index === siblings.length - 1) {
      rect.width = MORE_WIDTH
    } else if (index >= 1) {
      rect.width = ACTION_WIDTH
    }
  }
  return rect as DOMRect
}

// The hook re-measures whenever its ResizeObserver fires; the test drives
// that directly (a real jsdom layout never resizes on its own) by keeping the
// latest registered callback and invoking it once the header's width has
// been changed.
let fireResize: (() => void) | null = null
class FiringResizeObserverStub {
  private readonly callback: () => void
  constructor(callback: () => void) {
    this.callback = callback
    fireResize = callback
  }
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

const domGlobals = {
  cancelAnimationFrame: () => {},
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  ResizeObserver: FiringResizeObserverStub,
  // Runs the scheduled measurement synchronously, inside the same `act()`
  // that renders — this is the layout effect's own `requestAnimationFrame`
  // call, not a browser frame the test needs to wait for.
  requestAnimationFrame: (callback: FrameRequestCallback): number => {
    callback(0)
    return 1
  },
  window: dom.window,
}

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { ResponsivePageHeader } = await import(
  '../src/components/shared/ResponsivePageHeader.js'
)
const { partitionPageHeaderActions } = await import(
  '../src/components/shared/responsive-page-header-layout.js'
)

test('a header narrower than its actions still collapses the low-priority ones into "More"', () => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  const mount = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(mount)
  const root = createRoot(mount)

  const actions = [
    { id: 'one', label: 'One', onSelect: () => {}, priority: 30 },
    { id: 'two', label: 'Two', onSelect: () => {}, priority: 20 },
    { id: 'three', label: 'Three', onSelect: () => {}, priority: 10 },
  ]

  try {
    act(() => root.render(h(ResponsivePageHeader, { actions, title: 'Test screen' })))

    // The header itself measures via `clientWidth`, which jsdom always
    // answers 0 for — narrow it explicitly to the width this test reasons
    // about, then fire the ResizeObserver the hook registered to trigger a
    // fresh measurement (the props are unchanged, so nothing else would).
    const header = mount.querySelector('header') as HTMLElement
    Object.defineProperty(header, 'clientWidth', { configurable: true, value: 260 })
    assert.ok(fireResize, 'the hook should have registered a ResizeObserver')
    act(() => fireResize?.())

    // Cross-check against the pure partition function this hook delegates
    // to, with the same inputs the hook computed: leadingReserve is the
    // 152px floor (no leading/onBack rendered), so available width is
    // 260 - 152 = 108.
    const expected = partitionPageHeaderActions(
      actions.map((action) => ({ id: action.id, priority: action.priority, width: ACTION_WIDTH })),
      108,
      MORE_WIDTH,
    )
    assert.ok(expected.overflowIds.length > 0, 'test setup should force an overflow')

    const visibleButtons = Array.from(mount.querySelectorAll('button')).filter(
      (button) => !button.closest('[aria-hidden="true"]'),
    )
    const visibleLabels = visibleButtons
      .map((button) => button.textContent?.trim())
      .filter((label): label is string => Boolean(label) && label !== 'More')

    for (const id of expected.visibleIds) {
      const label = actions.find((action) => action.id === id)?.label
      assert.ok(label && visibleLabels.includes(label), `${label} should stay visible`)
    }
    for (const id of expected.overflowIds) {
      const label = actions.find((action) => action.id === id)?.label
      assert.ok(label && !visibleLabels.includes(label), `${label} should collapse into More`)
    }

    const moreTrigger = mount.querySelector('[aria-label="More page actions"]')
    assert.ok(moreTrigger, 'a "More" trigger renders once actions overflow')
  } finally {
    act(() => root.unmount())
    mount.remove()
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
