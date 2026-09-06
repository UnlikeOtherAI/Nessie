import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import { openOverlayIn } from './support/overlay-host'
import * as ReactNamespace from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { SHEET_SIZE_STYLE, Sheet } from '../src/components/overlays/Sheet.js'
import { resolveSheetSwipeOutcome, sheetEdgeTravel } from '../src/components/overlays/sheet-swipe.js'
import { PHONE_BACK_SWIPE_COMMIT_RATIO } from '../src/navigation/phone-navigation-gesture.js'

/**
 * The shared edge-anchored overlay shell. Eight drawers each hand-rolled a
 * scrim, a literal z-index pair and a transition, and none of them had Escape,
 * a focus trap, a dialog role or a Back registration. These tests pin both
 * halves of the promise the primitive makes: what it always announces, and the
 * close paths it owns — Escape, the Back registry, and the swipe.
 */

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const render = (props: Partial<Parameters<typeof Sheet>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(Sheet, {
      children: createElement('p', null, 'body'),
      onClose: () => undefined,
      open: true,
      side: 'right',
      title: 'Attachments',
      ...props,
    }),
  )

test('the shell always announces itself as a modal dialog', () => {
  const html = render()
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-modal="true"/)
  // Focusable so the trap has somewhere to put focus in an empty panel.
  assert.match(html, /tabindex="-1"/)
})

test('the label is the sheet title, wired by id to a heading the drawers do not repeat', () => {
  const html = render()
  const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1]
  assert.ok(labelledBy, 'the panel carries aria-labelledby')
  assert.ok(
    html.includes(`class="sr-only" id="${labelledBy}">Attachments</h2>`),
    'aria-labelledby points at the heading that holds the title',
  )
})

test('a closed sheet renders nothing at all', () => {
  assert.equal(render({ open: false }), '')
})

test('the scrim sits in the sheet layer of the one scale, over var(--scrim)', () => {
  const html = render()
  assert.match(html, /z-index:var\(--layer-sheet, 60\)/)
  assert.match(html, /background:var\(--scrim\)/)
  // No literal stacking value survives the conversion.
  assert.doesNotMatch(html, /z-index:\d/)
})

test('each side anchors to its own edge', () => {
  assert.match(render({ side: 'left', size: 'auto' }), /left:0/)
  assert.match(render({ side: 'right', size: 'auto' }), /right:0/)
  assert.match(render({ side: 'bottom' }), /bottom:0/)
})

// `size` is the four geometries the drawers ship, not a general scale.
test('only the shipped sizes are on offer', () => {
  assert.deepEqual(Object.keys(SHEET_SIZE_STYLE).sort(), ['auto', 'lg', 'md', 'sm'])
  assert.equal(SHEET_SIZE_STYLE.auto?.maxWidth, '85vw')
  assert.equal(SHEET_SIZE_STYLE.sm?.width, 'min(360px, 100vw)')
  assert.equal(SHEET_SIZE_STYLE.md?.width, 'min(430px, 100vw)')
  assert.equal(SHEET_SIZE_STYLE.lg?.width, 'min(620px, calc(100vw - 1.5rem))')
})

// The one allowed layout branch: a server render reports the single-column
// layout, where a sized side sheet covers the screen and `auto` — the nav
// drawer, whose scrim must stay tappable — deliberately does not.
test('on the single layout a sized side sheet is full-bleed and auto is not', () => {
  const sized = render({ side: 'right', size: 'md' })
  assert.match(sized, /width:100%/)
  assert.doesNotMatch(sized, /min\(430px/)
  assert.match(render({ side: 'left', size: 'auto' }), /max-width:85vw/)
})

// The primitive owns no motion of its own: the slide is the shared overlay
// transition on the drawer token, run from useOverlay.
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('the shell declares no transition or animation of its own', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/components/overlays/Sheet.tsx', import.meta.url)),
    'utf8',
  )
  const code = withoutComments(source)
  assert.doesNotMatch(code, /transition/)
  assert.doesNotMatch(code, /animation/)
  assert.doesNotMatch(code, /@keyframes/)
  assert.match(code, /useOverlay\(/)
})

// ---------------------------------------------------------------------------
// The swipe decision, which is the phone back-swipe's rule projected onto the
// sheet's own axis rather than a second set of thresholds.
// ---------------------------------------------------------------------------

test('travel is measured toward the sheet edge, whichever edge that is', () => {
  assert.equal(sheetEdgeTravel('right', 40, 0), 40)
  assert.equal(sheetEdgeTravel('left', 40, 0), -40)
  assert.equal(sheetEdgeTravel('left', -40, 0), 40)
  assert.equal(sheetEdgeTravel('bottom', 0, 40), 40)
})

test('a drag past the shared commit ratio closes; a short one and a wrong-way one do not', () => {
  const drag = (side: 'left' | 'right' | 'bottom', to: { x: number; y: number }) =>
    resolveSheetSwipeOutcome({
      extentPx: 400,
      samples: [
        { clientX: 0, clientY: 0, time: 0 },
        { clientX: to.x, clientY: to.y, time: 400 },
      ],
      side,
    })

  const past = Math.ceil(400 * PHONE_BACK_SWIPE_COMMIT_RATIO) + 1
  assert.equal(drag('right', { x: past, y: 0 }), 'commit')
  assert.equal(drag('left', { x: -past, y: 0 }), 'commit')
  assert.equal(drag('bottom', { x: 0, y: past }), 'commit')
  assert.equal(drag('right', { x: 20, y: 0 }), 'cancel', 'a nudge snaps back')
  assert.equal(drag('right', { x: -past, y: 0 }), 'cancel', 'away from the edge never closes')
  assert.equal(
    resolveSheetSwipeOutcome({ extentPx: 0, samples: [], side: 'right' }),
    'cancel',
    'a panel with no measured extent cannot produce progress',
  )
})

// ---------------------------------------------------------------------------
// Close paths. These need real event dispatch and a Back registry, so they
// mount into jsdom the way the dialog-shell suite does.
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/channels',
})

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { LocalBackProvider, useLocalBackSnapshot } = await import(
  '../src/navigation/LocalBackContext.js'
)

// Every file in this package's suite shares one process
// (`--experimental-test-isolation=none`), so the DOM globals are installed for
// the duration of a mount and removed again on unmount.
const domGlobals = {
  document: dom.window.document,
  Element: dom.window.Element,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  navigator: dom.window.navigator,
  window: dom.window,
}

type TouchPoint = { clientX: number; clientY: number }

// jsdom ships a TouchEvent constructor but no Touch, and React reads `touches`
// straight off the native event, so a plain event carrying the list is exactly
// what the handler sees in a browser.
const touchEvent = (type: string, points: TouchPoint[]): Event => {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', { value: points })
  Object.defineProperty(event, 'targetTouches', { value: points })
  Object.defineProperty(event, 'changedTouches', { value: points })
  return event
}

const mount = async () => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  let closes = 0
  let backOwner: string | null = null
  const BackProbe = () => {
    backOwner = useLocalBackSnapshot()?.active?.id ?? null
    return null
  }

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      h(
        LocalBackProvider,
        null,
        h(
          Sheet,
          {
            onClose: () => {
              closes += 1
            },
            open: true,
            side: 'right',
            size: 'md',
            title: 'Attachments',
          },
          h('button', { type: 'button' }, 'Add attachment'),
        ),
        h(BackProbe, null),
      ),
    )
  })

  // Not `container`: the overlay portals out of the tree it was rendered in.
  const scrim = openOverlayIn(dom.window.document)
  const panel = scrim.firstElementChild as HTMLElement
  // jsdom lays nothing out, so the panel reports a zero extent; the swipe
  // needs a real one to turn travel into progress.
  Object.defineProperty(panel, 'offsetWidth', { configurable: true, value: 400 })

  const fire = async (target: EventTarget, event: Event) => {
    await act(async () => {
      target.dispatchEvent(event)
    })
  }

  const swipe = async (points: TouchPoint[]) => {
    const first = points[0] as TouchPoint
    await fire(panel, touchEvent('touchstart', [first]))
    for (const point of points.slice(1)) {
      await fire(panel, touchEvent('touchmove', [point]))
    }
    await fire(panel, touchEvent('touchend', []))
  }

  return {
    backOwner: () => backOwner,
    closes: () => closes,
    pressEscape: () =>
      fire(
        panel,
        new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
      ),
    swipe,
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

test('an open sheet owns Back, closes on Escape, and closes on a swipe toward its edge', async () => {
  const view = await mount()
  try {
    assert.match(
      view.backOwner() ?? '',
      /^overlay:/,
      'the registry hands Back to the open overlay',
    )

    await view.pressEscape()
    assert.equal(view.closes(), 1, 'Escape closes')

    await view.swipe([
      { clientX: 100, clientY: 200 },
      { clientX: 140, clientY: 202 },
      { clientX: 320, clientY: 204 },
    ])
    assert.equal(view.closes(), 2, 'a drag toward the right edge past the threshold closes')

    await view.swipe([
      { clientX: 100, clientY: 200 },
      { clientX: 118, clientY: 201 },
    ])
    assert.equal(view.closes(), 2, 'a nudge snaps back instead')
  } finally {
    await view.unmount()
  }
})

// ---------------------------------------------------------------------------
// Per-drawer conversion pins: each converted file renders a Sheet and no longer
// declares its own stacking value or panel transition.
// ---------------------------------------------------------------------------

const CONVERTED = [
  '../src/layouts/admin-shell/MobileNavDrawer.tsx',
  '../src/components/features/knowledge/AttachmentsDrawer.tsx',
  '../src/components/features/agents/AgentDetailDrawer.tsx',
  '../src/components/features/channels/ChannelAgentInfoDrawer.tsx',
  '../src/components/features/channels/ChannelUserInfoDrawer.tsx',
]

test('every converted drawer renders a Sheet and owns no z-index or transition', () => {
  for (const relativePath of CONVERTED) {
    const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
    assert.match(source, /<Sheet\b/, relativePath)
    assert.match(source, /from '[^']*overlays\/Sheet'/, relativePath)
    assert.doesNotMatch(source, /z-\[/, relativePath)
    assert.doesNotMatch(source, /\bz-\d/, relativePath)
    assert.doesNotMatch(source, /zIndex/, relativePath)
    assert.doesNotMatch(source, /transition-/, relativePath)
    // The scrim, Escape and focus trap now come from the one hook.
    assert.doesNotMatch(source, /fixed inset-0/, relativePath)
  }
})
