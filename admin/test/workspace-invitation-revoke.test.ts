import assert from 'node:assert/strict'
import test from 'node:test'

import type { ApiClient } from '@nessie/client-core'
import { JSDOM } from 'jsdom'

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

// The facade's query keys. Seeding them keeps the render deterministic without
// waiting on a fetch, exactly as the billing render test does.
const MEMBERS_KEY = ['workspace', 'members']
const INVITATIONS_KEY = ['workspace', 'invitations']

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

const mount = async (canManage: boolean) => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  const calls: Recorded[] = []
  const record = (method: string) => async (path: string) => {
    calls.push({ method, path })
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

  const queryClient = new QueryClient()
  queryClient.setQueryData(MEMBERS_KEY, { members: [] })
  queryClient.setQueryData(INVITATIONS_KEY, invitations)

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
          h(WorkspaceMembersSection, { canManage }),
        ),
      ),
    )
  })

  const buttons = (label: string): HTMLElement[] =>
    [...container.querySelectorAll('button')].filter(
      (button) => button.textContent?.trim() === label,
    ) as HTMLElement[]

  return {
    buttons,
    calls,
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
