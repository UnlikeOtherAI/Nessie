import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import * as ReactNamespace from 'react'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { Popover } from '../src/components/overlays/Popover.js'
import { OVERLAY_BACK_PRIORITY, OVERLAY_LAYER } from '../src/navigation/overlay.js'
import { stubResizeObserver } from './support/resize-observer-stub'

/**
 * The anchored-overlay primitive (docs/navigation/overview.md §7). Every menu, picker and
 * suggestion list in the admin used to carry its own fixed panel, its own
 * `z-[6x]`, its own outside-press listener and (five times over) its own
 * flip/clamp routine. These pin what the primitive always emits, the close paths
 * it owns, and the Back rule that separates it from a modal.
 */

// The production Vite transform injects the JSX runtime; Node's tsx loader uses
// the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const sourceRoot = fileURLToPath(new URL('../src', import.meta.url))
const read = (relative: string): string => readFileSync(`${sourceRoot}/${relative}`, 'utf8')

const render = (props: Partial<Parameters<typeof Popover>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(Popover, {
      anchorRef: createRef<HTMLElement>(),
      children: createElement('p', null, 'body'),
      label: 'Account menu',
      onClose: () => undefined,
      open: true,
      ...props,
    }),
  )

test('a popover always announces its role and its accessible name', () => {
  const html = render()
  // Default role: a popover whose content is not a menu or a list is a dialog.
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-label="Account menu"/)
  assert.match(render({ role: 'menu' }), /role="menu"/)
  assert.match(render({ role: 'listbox' }), /role="listbox"/)
  // A popover never claims to be modal: it does not trap focus.
  assert.doesNotMatch(html, /aria-modal/)
})

test('a closed popover renders nothing at all', () => {
  assert.equal(render({ open: false }), '')
})

test('the panel sits in the popover layer of the one scale, and declares no other z-index', () => {
  const html = render()
  assert.match(html, /z-index:var\(--layer-popover, 50\)/)
  assert.equal(OVERLAY_LAYER.popover, 50)
  assert.doesNotMatch(html, /z-index:(?!var)/)
  assert.doesNotMatch(html, /9999|10000/)
})

// Before the first measurement the panel is in the DOM at its natural size so
// it can be measured at all; it must not be painted at 0,0 while that happens.
test('an unmeasured panel is laid out but not painted', () => {
  const html = render()
  assert.match(html, /position:fixed/)
  assert.match(html, /visibility:hidden/)
})

test('the primitive composes useOverlay, and nothing else composes the internals', () => {
  const source = read('components/overlays/Popover.tsx')
  assert.match(source, /useOverlay\(\{/)
  assert.match(source, /kind: 'popover'/)
  // Element anchors go through D11's observed placement; rect anchors (the
  // editor caret) still place synchronously through the pure helper.
  assert.match(source, /usePopoverPlacement\(/)
  assert.match(source, /placePopover\(/)
  // Motion is the hook's; a popover never writes a CSS transition of its own.
  assert.doesNotMatch(source, /transition:/)
  assert.doesNotMatch(source, /useModalA11y|useOverlayDismiss/)
})

// The Back rule that separates a popover from a modal: Android's hardware key
// closes an open menu, and on a split layout it must not do so instead of
// navigating. The precedence itself is asserted in navigation-overlay.test.ts.
test('a popover owns Back only on a single-column layout', () => {
  const hook = read('components/overlays/useOverlay.ts')
  assert.match(hook, /active: open && \(kind !== 'popover' \|\| layout === 'single'\)/)
  assert.ok(OVERLAY_BACK_PRIORITY.popover < OVERLAY_BACK_PRIORITY.sheet)
})

// ---------------------------------------------------------------------------
// Adoption. Each converted file renders the primitive and owns no layer of its
// own — the whole point of the scale is that only the primitives declare one.
// ---------------------------------------------------------------------------

const CONVERTED = [
  'layouts/admin-shell/UserMenuPopover.tsx',
  'layouts/admin-shell/TeamMenu.tsx',
  'layouts/admin-shell/CreateMenuTrigger.tsx',
  'layouts/admin-shell/AlertsBell.tsx',
  'components/shared/ResponsivePageHeader.tsx',
  'components/shared/AssigneePicker.tsx',
  'components/features/channels/ReactionPills.tsx',
  'components/features/channels/ComposerEmojiButton.tsx',
  'components/features/agents/designer/ModelCombobox.tsx',
  'components/features/knowledge/wikilink/WikilinkSuggestionMenu.tsx',
  'pages/settings/statuses/StatusEmojiPicker.tsx',
]

for (const relative of CONVERTED) {
  test(`${relative} renders the Popover primitive and declares no z-index of its own`, () => {
    const source = read(relative)
    assert.match(source, /<Popover\b/)
    assert.doesNotMatch(source, /\bz-\[/)
    assert.doesNotMatch(source, /\bz-\d/)
    assert.doesNotMatch(source, /zIndex/)
  })
}

test('the five hand-rolled flip/clamp routines are gone', () => {
  // Placement geometry now exists in exactly one module. `window.innerWidth`
  // was the tell: every private routine clamped against it.
  for (const relative of [
    'layouts/admin-shell/UserMenuPopover.tsx',
    'layouts/admin-shell/TeamMenu.tsx',
    'layouts/admin-shell/CreateMenuTrigger.tsx',
    'components/features/channels/ReactionPills.tsx',
    'components/features/knowledge/wikilink/WikilinkSuggestionMenu.tsx',
  ]) {
    assert.doesNotMatch(read(relative), /innerWidth|innerHeight/, relative)
  }
  // …and the module that held the team menu's copy no longer exists.
  const shellFiles = readdirSync(`${sourceRoot}/layouts/admin-shell`)
  assert.ok(!shellFiles.includes('team-menu-position.ts'))
})

// ---------------------------------------------------------------------------
// Close paths. These need real event dispatch, so they mount into jsdom the way
// the dialog-shell suite does.
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/channels',
})
stubResizeObserver(dom.window)

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

const domGlobals = {
  document: dom.window.document,
  Element: dom.window.Element,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  navigator: dom.window.navigator,
  // The outside-press guard narrows an event target with `instanceof Node`.
  Node: dom.window.Node,
  window: dom.window,
}

const mount = async () => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  let closes = 0
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const trigger = dom.window.document.createElement('button')
  dom.window.document.body.appendChild(trigger)
  const outside = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(outside)

  const root = createRoot(container)
  await act(async () => {
    root.render(
      h(
        Popover,
        {
          anchorRef: { current: trigger },
          label: 'Account menu',
          onClose: () => {
            closes += 1
          },
          open: true,
          role: 'menu',
        },
        h('button', { type: 'button' }, 'Log out'),
      ),
    )
  })

  // Not `container`: the popover portals out of the tree it was rendered in.
  const panel = dom.window.document.querySelector('[role="menu"]') as HTMLElement
  const press = async (target: HTMLElement) => {
    await act(async () => {
      target.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    })
  }

  return {
    closes: () => closes,
    panel,
    pressAnchor: () => press(trigger),
    pressInside: () => press(panel.querySelector('button') as HTMLElement),
    pressOutside: () => press(outside),
    pressEscape: async () => {
      await act(async () => {
        dom.window.document.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
        )
      })
    },
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
      trigger.remove()
      outside.remove()
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

test('an outside press closes; a press on the panel or on its trigger does not', async () => {
  const view = await mount()
  try {
    await view.pressInside()
    assert.equal(view.closes(), 0, 'a press inside the panel is not an outside press')
    // The trigger owns the toggle: closing here would let it re-open at once.
    await view.pressAnchor()
    assert.equal(view.closes(), 0, 'a press on the trigger is not an outside press')
    await view.pressOutside()
    assert.equal(view.closes(), 1)
  } finally {
    await view.unmount()
  }
})

test('Escape closes a popover even though it never took focus', async () => {
  const view = await mount()
  try {
    await view.pressEscape()
    assert.equal(view.closes(), 1)
  } finally {
    await view.unmount()
  }
})

test('the mounted panel is fixed, in the popover layer, and carries its name', async () => {
  const view = await mount()
  try {
    assert.equal(view.panel.style.position, 'fixed')
    assert.match(view.panel.getAttribute('style') ?? '', /--layer-popover/)
    assert.equal(view.panel.getAttribute('aria-label'), 'Account menu')
  } finally {
    await view.unmount()
  }
})
