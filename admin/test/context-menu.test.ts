import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { JSDOM } from 'jsdom'
import * as ReactNamespace from 'react'

import { placePopover } from '../src/components/overlays/placePopover.js'
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX } from '../src/components/overlays/useContextMenu.js'
import { openOverlayIn } from './support/overlay-host'

/**
 * The admin's right-click menu (docs/plans/2026-09-16-documents-finder-ui/menus-and-dialogs.md §1).
 *
 * A composition of the two overlay primitives, not a fifth overlay kind, so
 * nothing here re-asserts the layer, the Back rule or the portal — the popover
 * and sheet suites own those (docs/navigation/overview.md §7). What is asserted
 * is what the primitives deliberately leave out and a menu cannot be correct
 * without: the menu-button focus pattern, the walk over items a person may not
 * use, placement taken from the pointer, and the one gesture touch has.
 */

;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/knowledge-base',
})

// `useNavigationLayout()` decides the layout, never a width, so the suite
// drives the media queries the store reads. `narrow` is `single`: a phone,
// where the menu is a bottom sheet and the pointer is coarse.
let narrow = false
dom.window.matchMedia = ((query: string) => ({
  addEventListener: () => {},
  addListener: () => {},
  dispatchEvent: () => false,
  matches: query.includes('min-width') ? !narrow : query.includes('coarse') ? narrow : false,
  media: query,
  onchange: null,
  removeEventListener: () => {},
  removeListener: () => {},
})) as unknown as typeof window.matchMedia

// Without the tokens the stylesheet emits, every band is false and the shell
// reads as `single` whatever the queries say.
for (const [name, value] of Object.entries({
  sm: '40rem',
  md: '48rem',
  lg: '64rem',
  xl: '80rem',
  '2xl': '96rem',
})) {
  dom.window.document.documentElement.style.setProperty(`--breakpoint-${name}`, value)
}

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
const { act, createElement: h, useRef } = React
const { createRoot } = await import('react-dom/client')
const { LocalBackProvider } = await import('../src/navigation/LocalBackContext.js')
const { __resetViewportStore } = await import('../src/hooks/useViewport.js')
const { ContextMenu } = await import('../src/components/overlays/ContextMenu.js')
const { useContextMenu } = await import('../src/components/overlays/useContextMenu.js')
type ContextMenuItem = Parameters<typeof ContextMenu>[0]['items'][number]

const selections: string[] = []

const ITEMS: ContextMenuItem[] = [
  { id: 'open', kind: 'item', label: 'Open', onSelect: () => selections.push('open') },
  {
    disabled: true,
    disabledReason: 'Only the person who shared this can rename it',
    id: 'rename',
    kind: 'item',
    label: 'Rename',
    onSelect: () => selections.push('rename'),
    shortcut: 'F2',
  },
  { kind: 'separator' },
  { kind: 'heading', label: 'Shared with 2 people' },
  {
    id: 'info',
    kind: 'item',
    label: 'Get Info',
    onSelect: () => selections.push('info'),
    shortcut: 'Mod+I',
  },
  { checked: true, id: 'view', kind: 'radio', label: 'Can view', onSelect: () => undefined },
  {
    destructive: true,
    id: 'delete',
    kind: 'item',
    label: 'Delete…',
    onSelect: () => selections.push('delete'),
  },
]

type Harness = {
  items: () => HTMLButtonElement[]
  focusedLabel: () => string | null
  menu: () => HTMLElement | null
  open: () => boolean
  panel: () => HTMLElement
  press: (key: string, init?: KeyboardEventInit) => Promise<void>
  pointer: (type: string, init: Record<string, unknown>) => Promise<void>
  rightClick: (x: number, y: number) => Promise<boolean>
  row: () => HTMLButtonElement
  unmount: () => Promise<void>
  flush: (ms?: number) => Promise<void>
}

// A case that fails before its own teardown would leave its menu open on the
// shared document, and the next case would read that one.
let takeDown: (() => Promise<void>) | null = null

const mountMenu = async (
  options: { items?: ContextMenuItem[]; narrow?: boolean } = {},
): Promise<Harness> => {
  await takeDown?.()
  narrow = options.narrow === true
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  // The store is memoised per process and this suite shares one: bind it to
  // this window and this file's media answers, not to whichever file ran first.
  __resetViewportStore()

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  let anchored = false
  const Row = () => {
    const menu = useContextMenu()
    const rowRef = useRef<HTMLButtonElement>(null)
    anchored = menu.anchor !== null
    return h(
      'div',
      null,
      h(
        'button',
        { ...menu.triggerProps, 'data-row': 'lease', ref: rowRef, type: 'button' },
        'Lease.pdf',
      ),
      h(ContextMenu, {
        anchor: menu.anchor,
        items: options.items ?? ITEMS,
        label: 'Actions for Lease.pdf',
        onClose: menu.close,
        returnFocusRef: rowRef,
      }),
    )
  }

  const flush = async (ms = 0) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms))
    })
  }

  await act(async () => {
    root.render(h(LocalBackProvider, null, h(Row)))
  })
  await flush()

  const row = () => container.querySelector('[data-row="lease"]') as HTMLButtonElement
  const menu = () => dom.window.document.querySelector('[role="menu"]') as HTMLElement | null
  const items = () =>
    Array.from(menu()?.querySelectorAll('[role="menuitem"],[role="menuitemradio"]') ?? []) as
      HTMLButtonElement[]

  const dispatch = async (target: EventTarget, event: Event) => {
    await act(async () => {
      target.dispatchEvent(event)
    })
    await flush()
  }

  const harness: Harness = {
    flush,
    focusedLabel: () => {
      const active = dom.window.document.activeElement as HTMLElement | null
      return active?.textContent?.trim() ?? null
    },
    items,
    menu,
    open: () => anchored,
    panel: () => openOverlayIn(dom.window.document),
    pointer: async (type, init) => {
      const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
      for (const [key, value] of Object.entries(init)) {
        Object.defineProperty(event, key, { configurable: true, value })
      }
      await dispatch(row(), event)
    },
    press: async (key, init = {}) => {
      const target = (dom.window.document.activeElement as HTMLElement | null) ?? row()
      await dispatch(
        target,
        new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...init }),
      )
    },
    rightClick: async (x, y) => {
      const event = new dom.window.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      })
      await dispatch(row(), event)
      return event.defaultPrevented
    },
    row,
    unmount: async () => {
      takeDown = null
      await act(async () => root.unmount())
      container.remove()
      for (const key of Object.keys(domGlobals)) {
        const descriptor = previousGlobals.get(key)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
  takeDown = harness.unmount
  return harness
}

test('a right-click opens the menu and the browser\'s own never shows', async () => {
  const harness = await mountMenu()
  assert.ok(harness.menu() === null, 'nothing is open before the gesture')
  const prevented = await harness.rightClick(120, 300)
  assert.ok(prevented, 'the native context menu is prevented, not raced')
  const menu = harness.menu()
  assert.ok(menu, 'a role="menu" panel is open')
  assert.equal(menu?.getAttribute('aria-label'), 'Actions for Lease.pdf')
  await harness.unmount()
})

// The whole reason a pointer anchor exists: the menu hangs off the point, and
// the point is what the one placePopover receives. jsdom lays nothing out, so
// every rect it reports is zero — which makes the rendered coordinates a
// direct read-out of the anchor the menu handed the placement helper.
test('the menu is placed from the pointer, not from the row', async () => {
  const harness = await mountMenu()
  await harness.rightClick(120, 300)
  const panel = harness.panel()
  assert.equal(panel.style.left, '120px', 'the panel is aligned to the pointer')
  assert.equal(panel.style.top, '308px', 'and hangs below it by the shared gap')
  await harness.unmount()
})

// The failure this is written against: a menu opened near the bottom of a
// short window runs off it. The flip is placePopover's, and the point anchor
// is what has to reach it.
test('a menu opened at the bottom edge flips above the pointer', async () => {
  const harness = await mountMenu()
  await harness.rightClick(40, 700)
  const panel = harness.panel()
  assert.equal(panel.style.top, '708px', 'it starts below the pointer while it fits')
  // Give the panel a real content height and let it measure again: jsdom
  // reports a zero-height box, and a zero-height panel fits anywhere.
  Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: 240 })
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.Event('resize'))
  })
  await harness.flush()
  assert.equal(panel.style.top, '452px', 'once it cannot fit below, it flips above the pointer')
  assert.ok(452 + 240 <= dom.window.innerHeight, 'and is inside the window again')
  await harness.unmount()
})

test('the point anchor flips through the one placement helper', () => {
  const placed = placePopover({
    anchor: { bottom: 700, left: 40, right: 40, top: 700 },
    bounds: { bottom: 768, left: 0, right: 1024, top: 0 },
    panel: { height: 240, width: 220 },
    placement: 'bottom-start',
  })
  assert.equal(placed.placement, 'top-start')
  assert.equal(placed.top, 452)
})

test('Shift+F10 opens the menu anchored to the focused row, and so does the ContextMenu key', async () => {
  const harness = await mountMenu()
  harness.row().focus()
  await harness.press('F10', { shiftKey: true })
  assert.ok(harness.menu(), 'the keyboard opens the same menu')
  await harness.press('Escape')
  await harness.flush()
  assert.ok(harness.menu() === null)

  harness.row().focus()
  await harness.press('ContextMenu')
  assert.ok(harness.menu(), 'the dedicated key opens it too')
  await harness.unmount()
})

test('focus lands on the first enabled item, never on the greyed one above it', async () => {
  const harness = await mountMenu()
  await harness.rightClick(120, 300)
  await harness.flush()
  assert.equal(harness.focusedLabel(), 'Open')
  await harness.unmount()
})

test('the arrows walk every item and wrap at both ends', async () => {
  const harness = await mountMenu()
  await harness.rightClick(120, 300)
  await harness.flush()
  await harness.press('ArrowDown')
  // A disabled item keeps its place in the walk: that is how a keyboard user
  // finds out it exists and why it is unavailable.
  assert.equal(harness.focusedLabel(), 'RenameF2')
  await harness.press('ArrowUp')
  assert.equal(harness.focusedLabel(), 'Open')
  await harness.press('ArrowUp')
  assert.equal(harness.focusedLabel(), 'Delete…', 'up from the first wraps to the last')
  await harness.press('ArrowDown')
  assert.equal(harness.focusedLabel(), 'Open', 'down from the last wraps to the first')
  await harness.press('End')
  assert.equal(harness.focusedLabel(), 'Delete…')
  await harness.press('Home')
  assert.equal(harness.focusedLabel(), 'Open')
  await harness.unmount()
})

test('a printable character jumps to the next item that starts with it', async () => {
  const harness = await mountMenu()
  await harness.rightClick(120, 300)
  await harness.flush()
  await harness.press('d')
  assert.equal(harness.focusedLabel(), 'Delete…')
  // The buffer lapses, the way it does for every list a person types into.
  await harness.flush(1_100)
  await harness.press('c')
  assert.equal(harness.focusedLabel(), 'Can view', 'the search wraps past the end')
  // Inside the window the characters accumulate: "ca" is still Can view.
  await harness.press('a')
  assert.equal(harness.focusedLabel(), 'Can view')
  await harness.unmount()
})

test('a disabled item is focusable, says why, and does nothing when chosen', async () => {
  const harness = await mountMenu()
  await harness.rightClick(120, 300)
  await harness.flush()
  const rename = harness.items().find((item) => item.textContent?.startsWith('Rename'))
  assert.ok(rename)
  assert.equal(rename?.getAttribute('aria-disabled'), 'true')
  assert.equal(rename?.hasAttribute('disabled'), false, 'a disabled attribute would hide it')
  assert.equal(
    rename?.getAttribute('title'),
    'Only the person who shared this can rename it',
  )
  selections.length = 0
  await act(async () => {
    rename?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  assert.deepEqual(selections, [], 'choosing it is not an action')
  assert.ok(harness.menu(), 'and it does not close the menu either')
  await harness.unmount()
})

test('the roles are the ones a screen reader walks a menu with', async () => {
  const harness = await mountMenu()
  await harness.rightClick(120, 300)
  const menu = harness.menu()
  assert.ok(menu)
  assert.equal(menu?.querySelectorAll('[role="separator"]').length, 1)
  assert.equal(menu?.querySelectorAll('[role="menuitemradio"]').length, 1)
  assert.equal(
    menu?.querySelector('[role="menuitemradio"]')?.getAttribute('aria-checked'),
    'true',
  )
  // The caption is not an item: axe's aria-required-children says a menu's
  // children are menuitems, separators and presentation.
  assert.equal(menu?.querySelectorAll('[role="presentation"]').length, 1)
  await harness.unmount()
})

// The close path a menu is judged on: the person who opened it with the
// keyboard has to get their place in the list back.
test('Escape closes the menu and returns focus to the row', async () => {
  const harness = await mountMenu()
  harness.row().focus()
  await harness.press('F10', { shiftKey: true })
  await harness.flush()
  assert.equal(harness.focusedLabel(), 'Open')
  await harness.press('Escape')
  await harness.flush()
  assert.ok(harness.menu() === null, 'the menu is closed')
  assert.ok(
    dom.window.document.activeElement === harness.row(),
    'focus is back on the row that opened it',
  )
  await harness.unmount()
})

test('choosing an item closes the menu first, then acts, and hands the row back', async () => {
  const harness = await mountMenu()
  selections.length = 0
  harness.row().focus()
  await harness.press('F10', { shiftKey: true })
  await harness.flush()
  await act(async () => {
    harness
      .items()[0]
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await harness.flush()
  assert.deepEqual(selections, ['open'])
  assert.ok(harness.menu() === null)
  assert.ok(dom.window.document.activeElement === harness.row())
  await harness.unmount()
})

test('Tab closes the menu rather than tabbing through it', async () => {
  const harness = await mountMenu()
  harness.row().focus()
  await harness.press('F10', { shiftKey: true })
  await harness.flush()
  await harness.press('Tab')
  await harness.flush()
  assert.ok(harness.menu() === null)
  await harness.unmount()
})

test('a shortcut is printed beside its item on a pointer-and-keyboard layout', async () => {
  const harness = await mountMenu()
  await harness.rightClick(120, 300)
  const info = harness.items().find((item) => item.textContent?.startsWith('Get Info'))
  assert.match(info?.textContent ?? '', /Get Info(⌘I|Ctrl\+I)$/)
  await harness.unmount()
})

// On `single` the menu is a bottom Sheet — the primitive that owns Back, so
// the hardware button closes the menu instead of leaving the folder.
test('on a single-column layout a long press opens the bottom sheet', async () => {
  const harness = await mountMenu({ narrow: true })
  await harness.pointer('pointerdown', { clientX: 40, clientY: 400, pointerType: 'touch' })
  assert.ok(harness.menu() === null, 'a press is not yet a long press')
  await harness.flush(LONG_PRESS_MS + 80)
  const menu = harness.menu()
  assert.ok(menu, 'the long press opened the menu')
  assert.equal(
    menu?.closest('[role="dialog"]')?.getAttribute('aria-modal'),
    'true',
    'and it is the sheet, not the popover',
  )
  assert.equal(harness.items().length, 5)
  assert.equal(harness.items().some((item) => /⌘|Ctrl/.test(item.textContent ?? '')), false)
  await harness.unmount()
})

// The two presses that must not become one: a finger that starts scrolling a
// list, and a mouse button held down (which is a drag).
test('a scroll and a held mouse button never become a menu', async () => {
  const scrolled = await mountMenu({ narrow: true })
  await scrolled.pointer('pointerdown', { clientX: 40, clientY: 400, pointerType: 'touch' })
  await scrolled.pointer('pointermove', {
    clientX: 40,
    clientY: 400 + LONG_PRESS_SLOP_PX + 4,
    pointerType: 'touch',
  })
  await scrolled.flush(LONG_PRESS_MS + 80)
  assert.ok(scrolled.menu() === null, 'moving past the slop cancels the press')
  await scrolled.unmount()

  const mouse = await mountMenu({ narrow: true })
  await mouse.pointer('pointerdown', { clientX: 40, clientY: 400, pointerType: 'mouse' })
  await mouse.flush(LONG_PRESS_MS + 80)
  assert.ok(mouse.menu() === null, 'holding a mouse button down is a drag, not a menu')
  await mouse.unmount()
})
