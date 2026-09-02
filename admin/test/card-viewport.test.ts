import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import * as ReactNamespace from 'react'

import { cardRegionForLayout } from '../src/components/overlays/CardViewport.js'
import { OVERLAY_LAYER } from '../src/navigation/overlay.js'
import {
  __resetStackTransitionState,
  beginStackTransition,
} from '../src/navigation/transition-state.js'

/**
 * The ambient overlay region (docs/navigation/overview.md §7).
 *
 * Two promises: the region comes from the shell's own navigation layout rather
 * than a second breakpoint (the toast viewport used to carry its own
 * `max-width: 639.98px` media query, which disagrees with the shell the moment
 * the two drift — a native iPad reports a wide viewport and is laid out
 * `single`), and a card that arrives mid-push waits for the settle instead of
 * running a second motion across a moving screen.
 */

;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const sourceRoot = fileURLToPath(new URL('../src', import.meta.url))
const read = (relative: string): string => readFileSync(`${sourceRoot}/${relative}`, 'utf8')

test('the region is decided by the navigation layout, both ways', () => {
  assert.equal(cardRegionForLayout('split'), 'top-right')
  assert.equal(cardRegionForLayout('single'), 'bottom')
})

test('the viewport reads the shell layout, and the breakpoint fork is gone', () => {
  const viewport = read('components/overlays/CardViewport.tsx')
  assert.match(viewport, /useNavigationLayout\(\)/)
  assert.match(viewport, /whenStackSettled\(\)/)
  // No second breakpoint anywhere in the component: no query, no window read.
  assert.doesNotMatch(viewport, /matchMedia|innerWidth|atLeast\./)

  const css = read('providers/notifications.css')
  assert.doesNotMatch(css, /639\.98px/)
  assert.doesNotMatch(css, /@media/)
  assert.doesNotMatch(css, /notification-toast-viewport/)

  // Region geometry is one rule set keyed by that decision, not a query.
  const styles = read('styles.css')
  assert.match(styles, /\.card-viewport\[data-region='top-right'\]/)
  assert.match(styles, /\.card-viewport\[data-region='bottom'\]/)
})

test('a card never owns Back and never traps focus', () => {
  const card = read('components/overlays/Card.tsx')
  assert.match(card, /role="status"/)
  assert.match(card, /kind: 'card'/)
  // The Back registry and the focus trap live in useOverlay; a card composes
  // the transition alone, deliberately.
  assert.doesNotMatch(card, /useOverlay\(|useLocalBack|useModalA11y/)
})

test('the toast stack pushes through the one viewport', () => {
  const provider = read('providers/ToastProvider.tsx')
  assert.match(provider, /<CardViewport\b/)
  assert.doesNotMatch(provider, /ToastViewport/)
  // The auto-dismiss timer is unchanged; dismissal now marks the card leaving
  // so its motion can play before the row is removed.
  assert.match(provider, /TOAST_TTL_MS/)
  assert.match(provider, /leaving: true/)
})

// ---------------------------------------------------------------------------
// Mounted behaviour.
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/channels',
})

// jsdom implements no matchMedia, and the viewport store is built from one
// MediaQueryList per breakpoint. A stub that answers every query `false` puts
// the store on its narrowest band; the region assertions read the layout the
// shell actually reported rather than assuming which one that is.
dom.window.matchMedia ??= ((query: string) => ({
  addEventListener: () => {},
  addListener: () => {},
  dispatchEvent: () => false,
  matches: false,
  media: query,
  onchange: null,
  removeEventListener: () => {},
  removeListener: () => {},
})) as unknown as typeof window.matchMedia

for (const [name, value] of Object.entries({
  sm: '40rem',
  md: '48rem',
  lg: '64rem',
  xl: '80rem',
  '2xl': '96rem',
})) {
  dom.window.document.documentElement.style.setProperty(`--breakpoint-${name}`, value)
}

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { CardViewport } = await import('../src/components/overlays/CardViewport.js')
const { useNavigationLayout } = await import('../src/lib/mobile-shell.js')

const domGlobals = {
  document: dom.window.document,
  Element: dom.window.Element,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  window: dom.window,
}

type MountedCard = { id: string; label: string; leaving?: boolean }

const mount = async (initial: MountedCard[]) => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  const removed: string[] = []
  let setCards: ((next: MountedCard[]) => void) | null = null
  // A probe renders the layout the shell itself reports, so the assertion below
  // pins the wiring rather than whichever layout jsdom happens to land on.
  let observedLayout: 'single' | 'split' = 'split'

  const Host = () => {
    const [cards, update] = React.useState(initial)
    observedLayout = useNavigationLayout()
    setCards = update
    return h(CardViewport, {
      cards: cards.map((card) => ({
        children: h('span', null, card.label),
        id: card.id,
        leaving: card.leaving,
      })),
      onLeft: (id: string) => removed.push(id),
    })
  }

  await act(async () => {
    root.render(h(Host))
  })

  return {
    container,
    labels: () => Array.from(container.querySelectorAll('[role="status"]')).map((n) => n.textContent),
    layout: () => observedLayout,
    region: () => container.querySelector('.card-viewport')?.getAttribute('data-region') ?? null,
    removed,
    setCards: async (next: MountedCard[]) => {
      await act(async () => {
        setCards?.(next)
      })
    },
    settle: async () => {
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
    },
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
    zIndex: () =>
      (container.querySelector('.card-viewport') as HTMLElement | null)?.style.zIndex ?? null,
  }
}

test('a settled card shows at once, in the region its layout names, in the card layer', async () => {
  __resetStackTransitionState()
  const view = await mount([{ id: 'a', label: 'One' }])
  try {
    await view.settle()
    assert.deepEqual(view.labels(), ['One'])
    assert.equal(view.region(), cardRegionForLayout(view.layout()))
    assert.equal(view.zIndex(), `var(--layer-card, ${OVERLAY_LAYER.card})`)
  } finally {
    await view.unmount()
  }
})

test('a card arriving during a stack transition waits for the settle', async () => {
  __resetStackTransitionState()
  const endTransition = beginStackTransition()
  const view = await mount([{ id: 'a', label: 'One' }])
  try {
    await view.settle()
    assert.equal(view.region(), null, 'nothing is painted while the stack is moving')
    assert.deepEqual(view.labels(), [])

    await act(async () => {
      endTransition()
      await Promise.resolve()
    })
    await view.settle()
    assert.deepEqual(view.labels(), ['One'])
  } finally {
    await view.unmount()
    __resetStackTransitionState()
  }
})

test('a leaving card is removed only after its motion has played out', async () => {
  __resetStackTransitionState()
  const view = await mount([{ id: 'a', label: 'One' }])
  try {
    await view.settle()
    assert.deepEqual(view.removed, [])
    await view.setCards([{ id: 'a', label: 'One', leaving: true }])
    await view.settle()
    // jsdom has no Web Animations API, so the transition resolves at once — the
    // owner is told, and it is the owner that drops the row.
    assert.deepEqual(view.removed, ['a'])
    assert.deepEqual(view.labels(), ['One'], 'still mounted until the owner removes it')
    await view.setCards([])
    assert.deepEqual(view.labels(), [])
  } finally {
    await view.unmount()
  }
})
