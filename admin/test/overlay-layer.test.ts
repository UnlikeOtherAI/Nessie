import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import * as ReactNamespace from 'react'

/**
 * An overlay belongs to its layer (docs/navigation/overlays.md). Every overlay
 * portals to the document, out of the navigation-stack layer that hides a
 * covered screen, so the layer publishes its element and the overlay watches
 * it: while that screen is `hidden` or `inert`, the overlay's slot is hidden
 * and it stays mounted. The browser suite (`test:e2e:overlay-layer`) walks
 * the real stack; these pin the predicate and the slot.
 */

;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/projects/p/board',
})
const doc = dom.window.document

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { isLayerCovered, OverlayLayerProvider } = await import('../src/navigation/overlay-layer.js')
const { OverlayPortal } = await import('../src/components/overlays/OverlayPortal.js')

const domGlobals = {
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  document: doc,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  MutationObserver: dom.window.MutationObserver,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  window: dom.window,
}

const withDomGlobals = async (run: () => Promise<void>) => {
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  try {
    await run()
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

/** A stack screen as `PhoneNavigationLayer` renders it, with a node inside. */
const screen = () => {
  const layer = doc.createElement('div')
  layer.setAttribute('data-phone-navigation-route', 'projects:project')
  const inner = doc.createElement('section')
  layer.appendChild(inner)
  doc.body.appendChild(layer)
  return { inner, layer }
}

test('a plain connected element outside any stack screen is never covered', () => {
  const element = doc.createElement('div')
  doc.body.appendChild(element)
  assert.equal(isLayerCovered(element), false)
  element.remove()
  assert.equal(isLayerCovered(null), false)
})

test('an element is covered while the stack screen around it is inert or hidden', () => {
  const { inner, layer } = screen()
  assert.equal(isLayerCovered(inner), false, 'a screen on top')
  layer.setAttribute('inert', '')
  assert.equal(isLayerCovered(inner), true, 'the screen beneath a push is inert')
  layer.removeAttribute('inert')
  layer.hidden = true
  assert.equal(isLayerCovered(inner), true, 'a deeper retained screen is hidden')
  layer.hidden = false
  assert.equal(isLayerCovered(inner), false, 'and uncovered when it is on top again')
  layer.remove()
})

test('a layer element that is itself inert or hidden is covered — a stage container', () => {
  const container = doc.createElement('div')
  doc.body.appendChild(container)
  container.setAttribute('inert', '')
  assert.equal(isLayerCovered(container), true)
  container.removeAttribute('inert')
  container.hidden = true
  assert.equal(isLayerCovered(container), true)
  container.remove()
})

test('a disconnected element is never covered, whatever its attributes say', () => {
  const { inner, layer } = screen()
  layer.setAttribute('inert', '')
  layer.hidden = true
  layer.remove()
  assert.equal(inner.isConnected, false)
  assert.equal(isLayerCovered(inner), false)
  assert.equal(isLayerCovered(layer), false)
})

test('OverlayPortal gives every overlay its own slot, hidden while its layer is covered', async () => {
  await withDomGlobals(async () => {
    const { inner, layer } = screen()
    const container = doc.createElement('div')
    doc.body.appendChild(container)
    const root = createRoot(container)
    const getLayer = () => inner

    await act(async () => {
      root.render(h(React.Fragment, null,
        h(OverlayLayerProvider, { element: getLayer },
          h(OverlayPortal, null, h('div', { 'data-overlay': 'first' })),
          h(OverlayPortal, null, h('div', { 'data-overlay': 'second' }))),
        // Nothing provides a layer here: never covered.
        h(OverlayPortal, null, h('div', { 'data-overlay': 'free' }))))
    })
    const flush = async () => {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0))
      })
    }
    await flush()

    const host = doc.querySelector('.admin-overlay-root')
    assert.ok(host, 'overlays render into the one host on the document')
    const slots = Array.from(host.children) as HTMLElement[]
    assert.equal(slots.length, 3, 'one slot per overlay')
    for (const slot of slots) {
      assert.ok(slot.classList.contains('admin-overlay-slot'))
      assert.equal(slot.children.length, 1, 'each slot holds exactly one overlay')
    }
    const slotOf = (name: string) => doc.querySelector(`[data-overlay="${name}"]`)?.parentElement as HTMLElement
    const hiddenSlots = () => ['first', 'second', 'free'].filter((name) => slotOf(name).hidden)
    assert.deepEqual(hiddenSlots(), [], 'nothing is hidden while the layer is on top')

    layer.setAttribute('inert', '')
    await flush()
    assert.deepEqual(hiddenSlots(), ['first', 'second'], 'the layer\'s overlays hide while it is inert')
    assert.equal(slotOf('first').getAttribute('data-overlay-covered'), 'true')
    assert.ok(doc.querySelector('[data-overlay="first"]'), 'still mounted')

    layer.removeAttribute('inert')
    await flush()
    assert.deepEqual(hiddenSlots(), [], 'and are back when it is on top again')
    assert.equal(slotOf('first').hasAttribute('data-overlay-covered'), false)

    layer.hidden = true
    await flush()
    assert.deepEqual(hiddenSlots(), ['first', 'second'], 'a hidden screen covers them too')

    await act(async () => {
      root.unmount()
    })
    container.remove()
    layer.remove()
  })
})
