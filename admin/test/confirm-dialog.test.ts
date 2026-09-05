import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import { openOverlayIn } from './support/overlay-host'
import * as ReactNamespace from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ConfirmDialog } from '../src/components/shared/ConfirmDialog.js'

/**
 * The confirm-then-act dialog that replaced four `window.confirm` calls.
 *
 * `window.confirm` is synchronous: it blocked, answered, and the destructive
 * call ran on the same tick. This one is not, so the property worth pinning is
 * that nothing destructive can happen on any path except the confirm control —
 * not on the click that opens the dialog, not on Cancel, Escape, the scrim, or
 * the close cross.
 */

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const render = (props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(ConfirmDialog, {
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
      onCancel: () => undefined,
      onConfirm: () => undefined,
      open: true,
      title: 'Delete this message?',
      ...props,
    }),
  )

test('the question is the dialog’s accessible name', () => {
  const html = render()
  const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1]
  assert.ok(labelledBy, 'the shell wired a label')
  assert.ok(html.includes(`id="${labelledBy}">Delete this message?</h2>`))
  assert.match(html, /This cannot be undone\./)
})

// The `admin-button-danger` treatment `DocumentStreamLeaveConfirm` already uses.
test('a destructive confirm is the danger action, an ordinary one the primary', () => {
  assert.match(render(), /class="admin-button admin-button-danger"[^>]*>Delete</)
  assert.match(
    render({ confirmLabel: 'Continue', destructive: false }),
    /class="admin-button admin-button-primary"[^>]*>Continue</,
  )
})

// One of the four native confirms is a bare question with no consequence
// sentence; inventing one for it would have been new copy, not a conversion.
test('the body is omitted entirely when the confirm has no consequence sentence', () => {
  assert.doesNotMatch(render({ body: undefined }), /<p /)
})

test('a closed confirm renders nothing at all', () => {
  assert.equal(render({ open: false }), '')
})

test('cancel reads “Cancel” unless the call site says otherwise', () => {
  assert.match(render(), /data-testid="confirm-dialog-cancel"[^>]*>Cancel</)
  assert.match(
    render({ cancelLabel: 'Stay here' }),
    /data-testid="confirm-dialog-cancel"[^>]*>Stay here</,
  )
})

// ---------------------------------------------------------------------------
// The close paths. These need real event dispatch, so they mount into jsdom the
// way the dialog-shell suite does.
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/projects',
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

const mount = async () => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  let cancels = 0
  let confirms = 0
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      h(ConfirmDialog, {
        body: 'Its tasks return to the backlog.',
        confirmLabel: 'Delete',
        destructive: true,
        onCancel: () => {
          cancels += 1
        },
        onConfirm: () => {
          confirms += 1
        },
        open: true,
        title: 'Delete "Sprint 4"?',
      }),
    )
  })

  // Not `container`: the overlay portals out of the tree it was rendered in.
  const scrim = openOverlayIn(dom.window.document)
  const panel = scrim.firstElementChild as HTMLElement
  const query = (selector: string) => panel.querySelector(selector) as HTMLElement

  const fire = async (target: HTMLElement, event: Event) => {
    await act(async () => {
      target.dispatchEvent(event)
    })
  }
  const click = (target: HTMLElement) =>
    fire(target, new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))

  return {
    cancelButton: query('[data-testid="confirm-dialog-cancel"]'),
    cancels: () => cancels,
    click,
    clickCancel: () => click(query('[data-testid="confirm-dialog-cancel"]')),
    clickClose: () => click(query('button[aria-label="Close"]')),
    clickConfirm: () => click(query('[data-testid="confirm-dialog-confirm"]')),
    confirms: () => confirms,
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

// The whole point of the conversion: every way out of the dialog other than the
// confirm control is a refusal, and none of them can reach the destructive path.
test('only the confirm control confirms', async () => {
  const view = await mount()
  try {
    await view.clickCancel()
    await view.pressEscape()
    await view.scrimClick()
    await view.clickClose()
    assert.equal(view.confirms(), 0, 'no dismissal confirms')
    assert.equal(view.cancels(), 4, 'all four dismissals cancel')

    await view.clickConfirm()
    assert.equal(view.confirms(), 1)
    assert.equal(view.cancels(), 4, 'confirming does not also cancel')
  } finally {
    await view.unmount()
  }
})

// A confirm reached by keyboard must not be completable by pressing Enter on
// arrival, so focus opens on Cancel rather than on the destructive control.
test('focus opens on cancel, not on the destructive control', async () => {
  const view = await mount()
  try {
    assert.equal(dom.window.document.activeElement, view.cancelButton)
  } finally {
    await view.unmount()
  }
})

// ---------------------------------------------------------------------------
// The copy is the only contract these four confirmations ever had: the native
// dialog contributed nothing but an OK button. The question and its consequence
// sentence therefore have to survive the conversion word for word.
// ---------------------------------------------------------------------------

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')

test('every converted confirm still says exactly what it said', () => {
  const messages = source('components/features/channels/useChannelMessageActions.tsx')
  assert.match(messages, /title="Delete this message\?"/)
  assert.match(messages, /body="This cannot be undone\."/)

  const projects = source('layouts/admin-shell/ProjectsSidebarNav.tsx')
  assert.ok(projects.includes('title={`Delete project "${deleteTarget.name}"?`}'))
  assert.match(projects, /body="This cannot be undone\."/)

  // The column editor moved out of ProjectSettingsPage when a project gained
  // many boards; the confirm it owns is unchanged.
  const columns = source('pages/project/settings/BoardColumnsEditor.tsx')
  assert.ok(columns.includes('title={`Delete column "${column.name}"?`}'))

  const iterations = source('pages/project/ProjectBacklogTab.tsx')
  assert.ok(iterations.includes('title={`Delete "${iteration.name}"?`}'))
  assert.match(iterations, /body="Its tasks return to the backlog\."/)
})

// The four destructive deletes are the reason this component exists; a fifth
// native confirm slipping back in would be invisible to every test above.
test('no admin surface asks through the browser any more', () => {
  const offenders = [
    'components/features/channels/useChannelMessageActions.tsx',
    'layouts/admin-shell/ProjectsSidebarNav.tsx',
    'pages/project/ProjectSettingsPage.tsx',
    'pages/project/ProjectBacklogTab.tsx',
  ].filter((path) => source(path).includes('window.confirm('))
  assert.deepEqual(offenders, [])
})
