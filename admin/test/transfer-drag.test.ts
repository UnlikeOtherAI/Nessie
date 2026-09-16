import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { JSDOM } from 'jsdom'
import * as ReactNamespace from 'react'

/**
 * ⌥ and the cross-root drop, in the hook that decides both
 * (docs/plans/2026-09-16-documents-finder-ui/transfer.md §1).
 *
 * `useFinderDrag` had one branch in Wave 1 — an in-space move — and the whole
 * question this file asks is whether the second branch tells the truth before
 * the button comes up. Across root folders ⌥ copies without asking and the `+`
 * is on screen while it is held; inside one root ⌥ means nothing, so the copy
 * cursor must not appear either. A cursor that promises a copy this plan does
 * not add is the bug, not a cosmetic one: it is the only thing a person has to
 * go on at the moment they let go.
 *
 * The prompt's own sentences are asserted in `transfer-prompt.test.ts`.
 */

;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/knowledge-base',
})

dom.window.matchMedia = ((query: string) => ({
  addEventListener: () => {},
  addListener: () => {},
  dispatchEvent: () => false,
  matches: query.includes('min-width'),
  media: query,
  onchange: null,
  removeEventListener: () => {},
  removeListener: () => {},
})) as unknown as typeof window.matchMedia

const domGlobals = {
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  document: dom.window.document,
  Element: dom.window.Element,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  MutationObserver: dom.window.MutationObserver,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  ResizeObserver: dom.window.ResizeObserver,
  window: dom.window,
}

after(() => {
  dom.window.close()
})

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { useFinderDrag } = await import(
  '../src/components/features/knowledge/finder/useFinderDrag.js'
)

const withDomGlobals = async <T>(run: () => Promise<T>): Promise<T> => {
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  try {
    return await run()
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
}

// A case that fails before its teardown leaves its tree on the shared document.
let takeDown: (() => Promise<void>) | null = null

type DragCall = { spaceId: string; alt: boolean }

const mountDrag = async () => {
  await takeDown?.()
  const moves: DragCall[] = []
  const foreign: DragCall[] = []
  const effects: string[] = []
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  const Host = () => {
    const drag = useFinderDrag({
      canDrop: () => true,
      onForeignDrop: (payload, _target, _point, altKey) =>
        foreign.push({ alt: altKey, spaceId: payload.spaceId }),
      onMove: (payload) => moves.push({ alt: false, spaceId: payload.spaceId }),
      rowsForDrag: () => ({ pageIds: ['page-1'], spaceId: 'space-source' }),
    })
    return h(
      'div',
      null,
      h('div', {
        'data-target': 'same',
        ...drag.dropHandlersFor('same', { kind: 'folder', parentPageId: 'f1', spaceId: 'space-source' }),
      }),
      h('div', {
        'data-target': 'other',
        ...drag.dropHandlersFor('other', { kind: 'folder', parentPageId: null, spaceId: 'space-other' }),
      }),
      h('button', {
        'data-drag-source': 'true',
        onDragStart: drag.dragStart('page-1'),
        type: 'button',
      }),
    )
  }

  await act(async () => {
    root.render(h(Host))
  })

  const dataTransfer = {
    dropEffect: 'none',
    effectAllowed: 'none',
    getData: () => '',
    setData: () => undefined,
    types: [] as string[],
  }

  const fire = async (selector: string, type: string, altKey: boolean) => {
    const node = container.querySelector(selector) as HTMLElement
    const event = new dom.window.MouseEvent(type, { altKey, bubbles: true, clientX: 40, clientY: 60 })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    await act(async () => {
      node.dispatchEvent(event)
    })
    effects.push(dataTransfer.dropEffect)
  }

  const unmount = async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    takeDown = null
  }
  takeDown = unmount

  return { effects, fire, foreign, moves, unmount }
}

test('⌥ copies across root folders and is ignored inside one', async () => {
  await withDomGlobals(async () => {
    const drag = await mountDrag()
    await drag.fire('[data-drag-source]', 'dragstart', false)

    // Inside one root: ⌥ must not promise a copy this plan does not add.
    await drag.fire('[data-target="same"]', 'dragover', true)
    assert.equal(drag.effects.at(-1), 'move')
    assert.equal(
      dom.window.document.getElementById('finder-copy-badge'),
      null,
      'no + badge for a drag that cannot copy',
    )

    // Across root folders: the cursor and the badge both say copy.
    await drag.fire('[data-target="other"]', 'dragover', true)
    assert.equal(drag.effects.at(-1), 'copy')
    const badge = dom.window.document.getElementById('finder-copy-badge')
    assert.ok(badge, 'the + badge is on screen before the button comes up')
    assert.equal(badge?.textContent, '+')

    await drag.fire('[data-target="other"]', 'drop', true)
    assert.deepEqual(drag.foreign, [{ alt: true, spaceId: 'space-source' }])
    assert.deepEqual(drag.moves, [])
    assert.equal(
      dom.window.document.getElementById('finder-copy-badge'),
      null,
      'the badge goes with the drag',
    )
    await drag.unmount()
  })
})

test('a drop inside one root is an ordinary move and never asks', async () => {
  await withDomGlobals(async () => {
    const drag = await mountDrag()
    await drag.fire('[data-drag-source]', 'dragstart', false)
    await drag.fire('[data-target="same"]', 'dragover', false)
    await drag.fire('[data-target="same"]', 'drop', false)
    assert.deepEqual(drag.moves, [{ alt: false, spaceId: 'space-source' }])
    assert.deepEqual(drag.foreign, [])
    await drag.unmount()
  })
})
