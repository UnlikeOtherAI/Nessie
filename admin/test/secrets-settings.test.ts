import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import * as ReactNamespace from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  buildSecretCreateInput,
  CreateSecretDialog,
} from '../src/components/features/settings/CreateSecretDialog.js'
import { SecretMetadataTable } from '../src/components/features/settings/SecretMetadataTable.js'
import { ExpandableTable } from '../src/components/shared/ExpandableTable.js'
import type { ProjectRecord } from '../src/lib/api-client.js'
import type { CreateSecretInput, SecretRecord } from '../src/facades/secrets/hooks.js'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const secret: SecretRecord = {
  createdAt: '2026-08-31T12:00:00.000Z',
  description: null,
  expiresAt: null,
  name: 'STRIPE_API_KEY',
  provider: 'stripe',
  reference: 'secret_123',
  rotatedAt: null,
  scopeId: 'user-1',
  scopeType: 'personal',
  status: 'active',
  updatedAt: '2026-08-31T12:00:00.000Z',
}

const project: ProjectRecord = {
  avatarAttachmentId: null,
  avatarEmoji: null,
  createdAt: '2026-08-31T12:00:00.000Z',
  id: 'project-1',
  memberCount: 1,
  name: 'Payments',
  organizationId: 'org-1',
}

const precedenceContext = { userId: 'user-1', teamId: 'team-1', projectId: 'project-1' }

const renderTable = (props: Partial<Parameters<typeof SecretMetadataTable>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(SecretMetadataTable, {
      isLoading: false,
      onRevoke: () => undefined,
      precedenceContext,
      revokingReference: null,
      secrets: [secret],
      ...props,
    }),
  )

test('secret metadata is a semantic table with clear copy controls', () => {
  const html = renderTable()

  assert.match(html, /<table class="admin-table w-full border-collapse" style="min-width:46rem">/)
  assert.match(html, /<caption class="sr-only">Secrets table<\/caption>/)
  assert.match(html, /<th[^>]*scope="col"[^>]*><span[^>]*>Secret key<\/span><\/th>/)
  assert.match(html, /<th[^>]*scope="col"[^>]*><span[^>]*>Reference<\/span><\/th>/)
  assert.match(html, /STRIPE_API_KEY/)
  assert.match(html, /secret_123/)
  assert.match(html, /aria-label="Copy secret key"/)
  assert.match(html, /aria-label="Copy secret reference"/)
  assert.match(html, /type="button"[^>]*>Revoke<\/button>/)
})

test('the loading table keeps its shape with skeleton rows; the empty state breaks out of the frame', () => {
  const loading = renderTable({ isLoading: true, secrets: [] })
  const empty = renderTable({ secrets: [] })

  // Loading: the table's real shape (columns, header) stays put — a DataTable
  // skeleton, not a placeholder sentence — while rows fill with pulse bars.
  assert.match(loading, /<table /)
  assert.match(loading, /<thead>/)
  assert.match(loading, /<tbody>/)
  assert.match(loading, /animate-pulse/)
  assert.doesNotMatch(loading, /Loading secrets/)

  // Empty: no genuinely empty table pretending to hold rows — the shared
  // EmptyState card replaces the frame entirely.
  assert.doesNotMatch(empty, /<table/)
  assert.match(empty, /No secrets saved yet\. Use .Save a secret. to add one\./)
})

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/settings/secrets',
})

const React = await import('react')
const { act, createElement: h, useState } = React
const { createRoot } = await import('react-dom/client')

const installDom = () => {
  const previousAttachEvent = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    'attachEvent',
  )
  Object.defineProperty(dom.window.HTMLElement.prototype, 'attachEvent', {
    configurable: true,
    value: () => undefined,
  })
  const values = {
    document: dom.window.document,
    Element: dom.window.Element,
    Event: dom.window.Event,
    EventTarget: dom.window.EventTarget,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MouseEvent: dom.window.MouseEvent,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    window: dom.window,
  }
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    if (previousAttachEvent) {
      Object.defineProperty(dom.window.HTMLElement.prototype, 'attachEvent', previousAttachEvent)
    } else {
      Reflect.deleteProperty(dom.window.HTMLElement.prototype, 'attachEvent')
    }
  }
}

test('copying a secret reference announces useful feedback', async () => {
  const restoreDom = installDom()
  const previousClipboard = Object.getOwnPropertyDescriptor(dom.window.navigator, 'clipboard')
  const copied: string[] = []
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value: string) => { copied.push(value) } },
  })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(h(SecretMetadataTable, {
        isLoading: false,
        onRevoke: () => undefined,
        precedenceContext,
        revokingReference: null,
        secrets: [secret],
      }))
    })
    const copyReference = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy secret reference"]',
    )
    assert.ok(copyReference)

    await act(async () => copyReference.click())

    assert.deepEqual(copied, ['secret_123'])
    assert.equal(copyReference.textContent, 'Copied')
    assert.match(container.textContent ?? '', /Secret reference copied to clipboard\./)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    if (previousClipboard) Object.defineProperty(dom.window.navigator, 'clipboard', previousClipboard)
    else Reflect.deleteProperty(dom.window.navigator, 'clipboard')
    restoreDom()
  }
})

test('an Admin table stays in its own surface', async () => {
  const restoreDom = installDom()
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(h(SecretMetadataTable, {
        isLoading: false,
        onRevoke: () => undefined,
        precedenceContext,
        revokingReference: null,
        secrets: [secret],
      }))
    })
    assert.equal(container.querySelector('button[aria-label="Expand Secrets table"]'), null)
    assert.equal(dom.window.document.querySelector('[role="dialog"]'), null)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    restoreDom()
  }
})

test('an enabled content table opens in a near-fullscreen dialog', async () => {
  const restoreDom = installDom()
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(h(
        ExpandableTable,
        { expandable: true, label: 'Message table' },
        h('table', null, h('tbody', null, h('tr', null, h('td', null, 'Cell')))),
      ))
    })
    const expand = container.querySelector<HTMLButtonElement>('button[aria-label="Expand Message table"]')
    assert.ok(expand)

    await act(async () => expand.click())

    // The dialog is portalled out of this mount's container
    // (components/overlays/OverlayPortal.tsx), so it is read from the document.
    const dialog = dom.window.document.querySelector<HTMLElement>('[role="dialog"]')
    assert.ok(dialog)
    assert.equal(dialog.style.width, 'calc(100vw - 2rem)')
    assert.equal(dialog.style.height, 'calc(100dvh - 2rem)')
    assert.ok(dialog.querySelector('table'))

    const close = dialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    assert.ok(close)
    await act(async () => close.click())
    assert.equal(dom.window.document.querySelector('[role="dialog"]'), null)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    restoreDom()
  }
})

const SecretDialogHarness = ({ onCreate }: { onCreate: (input: CreateSecretInput) => Promise<unknown> }) => {
  const [open, setOpen] = useState(false)
  return h(
    React.Fragment,
    null,
    h('button', { onClick: () => setOpen(true), type: 'button' }, 'Save a secret'),
    h(CreateSecretDialog, {
      onClose: () => setOpen(false),
      onCreate,
      onSaved: () => setOpen(false),
      open,
      pending: false,
      projects: [project],
    }),
  )
}

test('the secret dialog opens and closes through the shared modal shell', async () => {
  const restoreDom = installDom()
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(h(SecretDialogHarness, {
        onCreate: async () => undefined,
      }))
    })
    const opener = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save a secret',
    )
    assert.ok(opener)
    await act(async () => opener.click())
    // The dialog is portalled out of this mount's container
    // (components/overlays/OverlayPortal.tsx), so it is read from the document.
    assert.ok(dom.window.document.querySelector('[role="dialog"]'))
    // No hardcoded id — `FormField` mints its own via `useId()` — so focus is
    // pinned with `initialFocusRef` instead. Without it the shell focuses its
    // own close cross, which precedes the form in the DOM.
    //
    // Compared as a boolean, never `assert.equal(node, node)`: a failed
    // strict-equal on two DOM nodes sends `util.inspect` through JSDOM's
    // prototype graph to build a diff, which took this file's process past
    // 13 GB and 100 seconds before the runner killed it. The failure it was
    // hiding is this very assertion.
    const nameInput = dom.window.document.querySelector<HTMLInputElement>(
      'input[placeholder="STRIPE_API_KEY"]',
    )
    assert.ok(nameInput)
    assert.equal(dom.window.document.activeElement === nameInput, true)

    const close = dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    assert.ok(close)
    await act(async () => close.click())
    assert.equal(dom.window.document.querySelector('[role="dialog"]'), null)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    restoreDom()
  }
})

test('the creation dialog prepares the scoped vault request and never treats invalid input as creatable', () => {
  assert.deepEqual(
    buildSecretCreateInput({
      name: 'stripe_api_key',
      scopeId: 'project-1',
      scopeType: 'project',
      value: 'temporary-test-value',
    }),
    {
      name: 'STRIPE_API_KEY',
      scopeId: 'project-1',
      scopeType: 'project',
      value: 'temporary-test-value',
    },
  )
  assert.equal(
    buildSecretCreateInput({
      name: 'stripe-key',
      scopeId: '',
      scopeType: 'personal',
      value: 'temporary-test-value',
    }),
    null,
  )
  assert.equal(
    buildSecretCreateInput({
      name: 'STRIPE_API_KEY',
      scopeId: '',
      scopeType: 'project',
      value: 'temporary-test-value',
    }),
    null,
  )
})
