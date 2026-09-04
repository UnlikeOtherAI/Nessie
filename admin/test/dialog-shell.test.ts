import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import { openOverlayIn } from './support/overlay-host'
import * as ReactNamespace from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { Dialog } from '../src/components/shared/Dialog.js'

/**
 * The shared centred-modal shell. Half the admin's dialogs used to ship with no
 * Escape, no focus trap, no focus restore and no `role="dialog"`; this shell
 * composes `useModalA11y` and `useOverlayDismiss` unconditionally, so those
 * affordances cannot be forgotten by a call site. The tests below pin the two
 * halves of that promise: the announcement the shell always emits, and the
 * close paths it owns — including their pending gate.
 */

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const render = (props: Partial<Parameters<typeof Dialog>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(Dialog, {
      children: createElement('p', null, 'body'),
      onClose: () => undefined,
      open: true,
      title: 'Create a channel',
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

test('the label is always the dialog title, wired by id', () => {
  const html = render()
  const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1]
  assert.ok(labelledBy, 'the panel carries aria-labelledby')
  assert.ok(
    html.includes(`id="${labelledBy}">Create a channel</h2>`),
    'aria-labelledby points at the heading that holds the title',
  )
})

// A dialog with nothing under its title must not claim a description that is
// not there: a dangling aria-describedby announces an empty string.
test('a description is announced only when one was given', () => {
  assert.doesNotMatch(render(), /aria-describedby/)
  const html = render({ description: 'in Product launch' })
  const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1]
  assert.ok(describedBy)
  assert.ok(html.includes(`id="${describedBy}">in Product launch</div>`))
})

test('a closed dialog renders nothing at all', () => {
  assert.equal(render({ open: false }), '')
})

// `size` names the bounded panel geometries the admin ships, not a general scale:
// `md` is the bare `.create-channel-panel` card, and the other sizes are the exact
// inline overrides their call sites require.
test('the scrim sits in the modal layer of the one scale, or the blocking layer when nested', () => {
  assert.match(render(), /z-index:var\(--layer-modal, 70\)/)
  assert.match(render({ blocking: true }), /z-index:var\(--layer-blocking, 80\)/)
  assert.doesNotMatch(render(), /9999/)
})

test('the shipped panel geometries are the only widths on offer', () => {
  assert.match(render(), /class="create-channel-panel" role="dialog"/)
  assert.match(
    render({ size: 'lg' }),
    /style="max-height:calc\(100dvh - 2rem\);max-width:640px;overflow-y:auto;width:100%"/,
  )
  assert.match(render({ size: 'xl' }), /style="max-height:88dvh;max-width:none;overflow-y:auto;width:min\(80vw, 1100px\)"/)
})

// ---------------------------------------------------------------------------
// Close paths. These need real event dispatch, so they mount into jsdom the way
// the team-invitation suite does.
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/channels',
})

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')

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

const mount = async (dismissDisabled: boolean) => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  let closes = 0
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      h(
        Dialog,
        {
          dismissDisabled,
          onClose: () => {
            closes += 1
          },
          open: true,
          title: 'Task details',
        },
        h('button', { type: 'button' }, 'Save'),
      ),
    )
  })

  // Not `container`: the overlay portals out of the tree it was rendered in.
  const scrim = openOverlayIn(dom.window.document)
  const panel = scrim.firstElementChild as HTMLElement
  const closeButton = panel.querySelector('button[aria-label="Close"]') as HTMLElement

  const fire = async (target: HTMLElement, event: Event) => {
    await act(async () => {
      target.dispatchEvent(event)
    })
  }

  return {
    clickClose: () =>
      fire(closeButton, new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })),
    closes: () => closes,
    pressEscape: () =>
      fire(
        panel,
        new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
      ),
    scrimClick: async () => {
      await fire(scrim, new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      await fire(scrim, new dom.window.MouseEvent('mouseup', { bubbles: true, cancelable: true }))
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
  }
}

test('every close path the shell owns reaches onClose', async () => {
  const view = await mount(false)
  try {
    await view.clickClose()
    assert.equal(view.closes(), 1, 'the close cross closes')
    await view.pressEscape()
    assert.equal(view.closes(), 2, 'Escape closes')
    await view.scrimClick()
    assert.equal(view.closes(), 3, 'a press-and-release on the scrim closes')
  } finally {
    await view.unmount()
  }
})

// The pending gate a dialog mid-submit relies on: a stray Escape or scrim click
// must not throw away an edit that is already on its way to the server.
test('dismissDisabled refuses every one of them', async () => {
  const view = await mount(true)
  try {
    await view.clickClose()
    await view.pressEscape()
    await view.scrimClick()
    assert.equal(view.closes(), 0)
  } finally {
    await view.unmount()
  }
})
