import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientError, type ApiClient } from '@nessie/client-core'
import { JSDOM } from 'jsdom'

import { workspaceKeys } from '../src/lib/query-keys.js'

/**
 * The Revoke action on a pending workspace invitation: it exists where an
 * owner/admin is already standing (Settings → Members → Pending invitations),
 * it calls the revoke route for that invite id, and it re-reads the lists the
 * way the sibling invitation actions do — UOA is the only state there is.
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/settings/members',
  pretendToBeVisual: true,
})

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { ApiClientProvider } = await import('@nessie/client-core')
const { WorkspaceMembersSection } = await import('../src/pages/settings/WorkspaceMembersSection.js')

// The production Vite transform injects the JSX runtime; the tsx loader used
// here uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

// Every file in this package's suite shares one process
// (`--experimental-test-isolation=none`), so the DOM globals are installed for
// the duration of a mount and removed again on unmount.
const domGlobals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  MouseEvent: dom.window.MouseEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
}

// Seeding the real query keys keeps the render deterministic without waiting on
// a fetch, exactly as the billing render test does.

const invitations = {
  invitations: [
    { inviteId: 'inv_1', email: 'new@acme.test', status: 'pending', teamRole: 'member' },
    // Still in the approval queue: deny is its stop verb, not revoke.
    {
      approvalStatus: 'pending',
      email: 'raised@acme.test',
      inviteId: 'inv_2',
      status: 'pending',
      teamRole: 'member',
    },
  ],
}

type Recorded = { method: string; path: string }

const mount = async (
  canManage: boolean,
  options: { memberError?: Error; onReconnect?: () => Promise<void> } = {},
) => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  const calls: Recorded[] = []
  const record = (method: string) => async (path: string) => {
    calls.push({ method, path })
    if (path === '/api/workspace/members' && options.memberError) throw options.memberError
    if (path === '/api/workspace/members') return { members: [] }
    if (path === '/api/workspace/invitations') return invitations
    return { ok: true }
  }
  const apiClient = {
    delete: record('DELETE'),
    get: record('GET'),
    patch: record('PATCH'),
    post: record('POST'),
    put: record('PUT'),
  } as unknown as ApiClient

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (!options.memberError) queryClient.setQueryData(workspaceKeys.members, { members: [] })
  queryClient.setQueryData(workspaceKeys.invitations, invitations)

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      h(
        QueryClientProvider,
        { client: queryClient },
        h(
          ApiClientProvider,
          { client: apiClient },
          h(WorkspaceMembersSection, { canManage, onReconnect: options.onReconnect }),
        ),
      ),
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  const buttons = (label: string): HTMLElement[] =>
    [...container.querySelectorAll('button')].filter(
      (button) => button.textContent?.trim() === label,
    ) as HTMLElement[]

  return {
    buttons,
    calls,
    text: () => container.textContent ?? '',
    click: async (element: HTMLElement) => {
      await act(async () => {
        element.dispatchEvent(
          new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
        )
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    },
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
      queryClient.clear()
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

test('an owner or admin can revoke a sent invitation from the pending list', async () => {
  const harness = await mount(true)

  try {
    const revoke = harness.buttons('Revoke')
    // One sent invitation is revocable; the one still awaiting approval keeps
    // Approve/Deny, which is UOA's verb for an invite that was never sent.
    assert.equal(revoke.length, 1)
    assert.equal(harness.buttons('Resend').length, 1)
    assert.equal(harness.buttons('Deny').length, 1)

    await harness.click(revoke[0])

    assert.deepEqual(
      harness.calls.filter((call) => call.path.includes('/revoke')),
      [{ method: 'POST', path: '/api/workspace/invitations/inv_1/revoke' }],
    )
    // Same refresh contract as resend, approve, and deny: UOA holds the state,
    // so both lists are re-read rather than patched locally.
    assert.ok(
      harness.calls.some(
        (call) => call.method === 'GET' && call.path === '/api/workspace/invitations',
      ),
    )
    assert.ok(
      harness.calls.some(
        (call) => call.method === 'GET' && call.path === '/api/workspace/members',
      ),
    )
  } finally {
    await harness.unmount()
  }
})

test('a member who cannot manage the workspace is offered no revoke', async () => {
  const harness = await mount(false)

  try {
    assert.equal(harness.buttons('Revoke').length, 0)
    assert.equal(
      harness.calls.some((call) => call.path.includes('/revoke')),
      false,
    )
  } finally {
    await harness.unmount()
  }
})

test('an unlinked UOA workspace offers a reconnection instead of a false outage', async () => {
  let reconnects = 0
  const harness = await mount(true, {
    memberError: new ApiClientError(
      'This workspace is not linked to an UnlikeOtherAI workspace',
      'WORKSPACE_NOT_LINKED',
      404,
    ),
    onReconnect: async () => {
      reconnects += 1
    },
  })

  try {
    assert.match(
      harness.text(),
      /can no longer be reached through UnlikeOtherAI/,
    )
    assert.doesNotMatch(harness.text(), /directory could not be reached/)
    assert.equal(harness.buttons('Reconnect workspace').length, 1)
    // The linked route also owns invitations, so do not leave an owner with a
    // form that can only return the same 404.
    assert.equal(harness.buttons('Send invitation').length, 0)
    assert.equal(
      harness.calls.some((call) => call.path === '/api/workspace/invitations'),
      false,
    )

    await harness.click(harness.buttons('Reconnect workspace')[0])
    assert.equal(reconnects, 1)
  } finally {
    await harness.unmount()
  }
})

test('a rejected active workspace offers reconnection from the live roster error', async () => {
  const harness = await mount(true, {
    // The API client can be bundled separately from this page, so recovery
    // reads the stable response fields rather than relying on `instanceof`.
    memberError: Object.assign(
      new Error('UnlikeOtherAI refused the request'),
      { code: 'WORKSPACE_MEMBERS_REJECTED', status: 404 },
    ),
    onReconnect: async () => {},
  })

  try {
    assert.match(harness.text(), /can no longer be reached through UnlikeOtherAI/)
    assert.equal(harness.buttons('Reconnect workspace').length, 1)
    assert.equal(harness.buttons('Send invitation').length, 0)
    assert.equal(
      harness.calls.some((call) => call.path === '/api/workspace/invitations'),
      false,
    )
  } finally {
    await harness.unmount()
  }
})

test('a UOA directory outage remains distinct from an unlinked workspace', async () => {
  const harness = await mount(false, {
    memberError: new ApiClientError(
      'The UnlikeOtherAI directory is temporarily unavailable',
      'UOA_DIRECTORY_UNAVAILABLE',
      502,
    ),
  })

  try {
    assert.match(harness.text(), /directory could not be reached/)
    assert.equal(harness.buttons('Reconnect workspace').length, 0)
  } finally {
    await harness.unmount()
  }
})
