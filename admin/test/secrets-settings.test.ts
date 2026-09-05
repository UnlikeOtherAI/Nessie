import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import * as ReactNamespace from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  buildSecretCreateInput,
  CreateSecretDialog,
  SECRET_CREATION_SCOPES,
} from '../src/components/features/settings/CreateSecretDialog.js'
import {
  belongsToSecretsPage,
  SecretMetadataTable,
} from '../src/components/features/settings/SecretMetadataTable.js'
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
  locked: false,
  name: 'STRIPE_API_KEY',
  provider: 'stripe',
  reference: 'secret_123',
  rotatedAt: null,
  scopeId: 'user-1',
  scopeType: 'personal',
  status: 'active',
  updatedAt: '2026-08-31T12:00:00.000Z',
}

const organizationSecret: SecretRecord = {
  ...secret,
  name: 'STRIPE_API_KEY',
  reference: 'secret_org',
  scopeId: 'org-1',
  scopeType: 'organization',
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
      pageScope: 'personal',
      precedenceContext,
      revokingReference: null,
      secrets: [secret],
      tab: 'active',
      ...props,
    }),
  )

test('secret metadata is a semantic table with clear copy controls', () => {
  const html = renderTable()

  // `max(…, 100%)`: the scroll viewport's own `min-width: 100%` is a stylesheet
  // rule an inline `min-width` outranks, which left the table narrower than the
  // frame drawn around it.
  assert.match(html, /<table class="admin-table w-full border-collapse" style="min-width:max\(46rem, 100%\)">/)
  assert.match(html, /<caption class="sr-only">Secrets table<\/caption>/)
  assert.match(html, /<th[^>]*scope="col"[^>]*><span[^>]*>Secret key<\/span><\/th>/)
  assert.match(html, /<th[^>]*scope="col"[^>]*><span[^>]*>Reference<\/span><\/th>/)
  assert.match(html, /STRIPE_API_KEY/)
  assert.match(html, /secret_123/)
  assert.match(html, /aria-label="Copy secret key"/)
  assert.match(html, /aria-label="Copy secret reference"/)
  assert.match(html, /type="button"[^>]*>Revoke<\/button>/)
})

test('the table is never wrapped in a card of its own', () => {
  // docs/standards/design-system.md → no nesting: the table owns its frame, so
  // the page must not put an `admin-card` around it as this surface once did.
  assert.doesNotMatch(renderTable(), /admin-card/)
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
  assert.match(empty, /border-dashed/)
  assert.match(empty, /No secrets reach you yet/)
})

test('the two tabs split live secrets from dead ones, and each drops the column the other needs', () => {
  const revoked: SecretRecord = { ...secret, reference: 'secret_dead', status: 'revoked' }
  const active = renderTable({ secrets: [secret, revoked], tab: 'active' })
  const dead = renderTable({ secrets: [secret, revoked], tab: 'revoked' })

  assert.match(active, /secret_123/)
  assert.doesNotMatch(active, /secret_dead/)
  // The tab is the status, so the Active tab does not repeat it in a column.
  assert.doesNotMatch(active, /<span[^>]*>Status<\/span>/)
  assert.match(active, /<span[^>]*>Precedence<\/span>/)

  assert.match(dead, /secret_dead/)
  assert.doesNotMatch(dead, /secret_123/)
  // Revoked and expired are different facts and this tab holds both, so it
  // keeps a Status column — and drops Precedence and Revoke, which are
  // meaningless for a secret that no longer resolves.
  assert.match(dead, /<span[^>]*>Status<\/span>/)
  assert.doesNotMatch(dead, /<span[^>]*>Precedence<\/span>/)
  assert.doesNotMatch(dead, />Revoke<\/button>/)
})

test('the organisation page drops the Scope column; the pages below keep it', () => {
  const organization = renderTable({
    pageScope: 'organization',
    secrets: [organizationSecret],
  })
  const personal = renderTable({ secrets: [organizationSecret, secret] })

  // Every row there is the organisation's, so the column would say one word
  // the page title already says.
  assert.doesNotMatch(organization, /<span[^>]*>Scope<\/span>/)
  assert.match(personal, /<span[^>]*>Scope<\/span>/)
  assert.match(personal, /Organisation/)
  assert.match(personal, /Personal/)
})

test('a page shows its own level and every level above it, never a sibling below', () => {
  const teamSecret = { ...secret, reference: 'secret_team', scopeId: 'team-1', scopeType: 'team' as const }

  assert.equal(belongsToSecretsPage(organizationSecret, 'organization', precedenceContext), true)
  assert.equal(belongsToSecretsPage(teamSecret, 'organization', precedenceContext), false)
  assert.equal(belongsToSecretsPage(secret, 'organization', precedenceContext), false)

  assert.equal(belongsToSecretsPage(organizationSecret, 'team', precedenceContext), true)
  assert.equal(belongsToSecretsPage(teamSecret, 'team', precedenceContext), true)
  assert.equal(belongsToSecretsPage(secret, 'team', precedenceContext), false)

  assert.equal(belongsToSecretsPage(organizationSecret, 'personal', precedenceContext), true)
  assert.equal(belongsToSecretsPage(teamSecret, 'personal', precedenceContext), true)
  assert.equal(belongsToSecretsPage(secret, 'personal', precedenceContext), true)

  // Another team's secret is nobody else's business, on any page.
  const otherTeam = { ...teamSecret, reference: 'secret_other', scopeId: 'team-9' }
  assert.equal(belongsToSecretsPage(otherTeam, 'team', precedenceContext), false)
  assert.equal(belongsToSecretsPage(otherTeam, 'personal', precedenceContext), false)
})

test('the narrower secret is Effective and the one it beats says who beat it', () => {
  const html = renderTable({ secrets: [organizationSecret, secret] })

  assert.match(html, />Effective</)
  assert.match(html, /Overridden by personal/)
})

test('a secret pinned by a lock above is shown, dimmed, and says who decided', () => {
  const locked = { ...organizationSecret, locked: true }
  const html = renderTable({ secrets: [locked, secret] })

  // Shown rather than hidden — the same bargain `ScopedSettingGate` strikes —
  // so nobody is left wondering where their credential went.
  assert.match(html, /secret_123/)
  assert.match(html, /Locked by organisation/)
  assert.match(html, /<tr class="opacity-60">/)
  // The locking level itself is the one in force, and says so.
  assert.match(html, />Effective</)
  assert.match(html, />Locked</)
  // A lock is not an override: naming a winner below would be a lie.
  assert.doesNotMatch(html, /Overridden by/)
})

test('a locked row keeps its Revoke button — an unusable secret is still one to remove', () => {
  const locked = { ...organizationSecret, locked: true }
  const html = renderTable({ secrets: [locked, secret] })

  assert.equal(html.match(/>Revoke<\/button>/g)?.length, 2)
})

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/settings/secrets',
})

const React = await import('react')
const { act, createElement: h, useState } = React
const { createRoot } = await import('react-dom/client')

const installDom = () => {
  // React's IE value-change polyfill is keyed on `attachEvent` existing, and
  // then calls `detachEvent` when the watched input loses focus. Shimming only
  // the first half makes any unmount of a focused field throw from inside
  // react-dom — noise that looks like a product failure and is not one.
  const previousEventShims = (['attachEvent', 'detachEvent'] as const).map((name) => [
    name,
    Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, name),
  ] as const)
  for (const [name] of previousEventShims) {
    Object.defineProperty(dom.window.HTMLElement.prototype, name, {
      configurable: true,
      value: () => undefined,
    })
  }
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
    for (const [name, descriptor] of previousEventShims) {
      if (descriptor) Object.defineProperty(dom.window.HTMLElement.prototype, name, descriptor)
      else Reflect.deleteProperty(dom.window.HTMLElement.prototype, name)
    }
  }
}

const tableProps = {
  isLoading: false,
  onRevoke: () => undefined,
  pageScope: 'personal' as const,
  precedenceContext,
  revokingReference: null,
  secrets: [secret],
  tab: 'active' as const,
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
      root.render(h(SecretMetadataTable, tableProps))
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
      root.render(h(SecretMetadataTable, tableProps))
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

type DialogHarnessProps = {
  onCreate: (input: CreateSecretInput) => Promise<unknown>
  pageScope?: 'personal' | 'team' | 'organization'
}

const SecretDialogHarness = ({ onCreate, pageScope = 'personal' }: DialogHarnessProps) => {
  const [open, setOpen] = useState(false)
  return h(
    React.Fragment,
    null,
    h('button', { onClick: () => setOpen(true), type: 'button' }, 'New secret'),
    h(CreateSecretDialog, {
      onClose: () => setOpen(false),
      onCreate,
      onSaved: () => setOpen(false),
      open,
      pageScope,
      pending: false,
      projects: [project],
      scopeId: pageScope === 'team' ? 'team-1' : 'org-1',
    }),
  )
}

const openDialog = async (
  container: HTMLElement,
  root: ReturnType<typeof createRoot>,
  props: DialogHarnessProps,
) => {
  await act(async () => {
    root.render(h(SecretDialogHarness, props))
  })
  const opener = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'New secret',
  )
  assert.ok(opener)
  await act(async () => opener.click())
}

test('the secret dialog opens and closes through the shared modal shell', async () => {
  const restoreDom = installDom()
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await openDialog(container, root, { onCreate: async () => undefined })
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

test('the lock switch exists exactly where something sits below', async () => {
  const restoreDom = installDom()
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  const lockSwitch = () =>
    dom.window.document.querySelector('[role="switch"][aria-label="Use this everywhere"]')

  try {
    // Personal is the bottom of the chain: a lock there would pin nobody, and
    // the API refuses it outright, so the control is absent rather than inert.
    await openDialog(container, root, { onCreate: async () => undefined })
    assert.equal(lockSwitch(), null)
    // The personal page still offers Project, which does have levels below it.
    assert.ok(dom.window.document.querySelector('select'))

    await act(async () => root.render(h('div')))
    await openDialog(container, root, { onCreate: async () => undefined, pageScope: 'team' })
    assert.ok(lockSwitch())
    // The team page writes one scope, so it shows no scope picker at all.
    assert.equal(dom.window.document.querySelector('select'), null)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    restoreDom()
  }
})

test('the creation dialog prepares the scoped vault request and never treats invalid input as creatable', () => {
  assert.deepEqual(
    buildSecretCreateInput({
      locked: false,
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
      locked: false,
      name: 'stripe-key',
      scopeId: '',
      scopeType: 'personal',
      value: 'temporary-test-value',
    }),
    null,
  )
  assert.equal(
    buildSecretCreateInput({
      locked: false,
      name: 'STRIPE_API_KEY',
      scopeId: '',
      scopeType: 'project',
      value: 'temporary-test-value',
    }),
    null,
  )
  // A team or organisation secret always names its level; the page supplies it.
  assert.equal(
    buildSecretCreateInput({
      locked: true,
      name: 'STRIPE_API_KEY',
      scopeId: '',
      scopeType: 'team',
      value: 'temporary-test-value',
    }),
    null,
  )
})

test('a lock is sent only from a scope that can hold one', () => {
  assert.deepEqual(
    buildSecretCreateInput({
      locked: true,
      name: 'STRIPE_API_KEY',
      scopeId: 'org-1',
      scopeType: 'organization',
      value: 'temporary-test-value',
    }),
    {
      locked: true,
      name: 'STRIPE_API_KEY',
      scopeId: 'org-1',
      scopeType: 'organization',
      value: 'temporary-test-value',
    },
  )
  // Personal cannot lock, so a stale switch value never reaches the API — the
  // form drops it rather than letting the request 400.
  assert.deepEqual(
    buildSecretCreateInput({
      locked: true,
      name: 'STRIPE_API_KEY',
      scopeId: '',
      scopeType: 'personal',
      value: 'temporary-test-value',
    }),
    {
      name: 'STRIPE_API_KEY',
      scopeType: 'personal',
      value: 'temporary-test-value',
    },
  )
})

test('no page offers a scope above its own level', () => {
  assert.deepEqual(SECRET_CREATION_SCOPES.organization, ['organization'])
  assert.deepEqual(SECRET_CREATION_SCOPES.team, ['team'])
  assert.deepEqual(SECRET_CREATION_SCOPES.personal, ['personal', 'project'])
})
