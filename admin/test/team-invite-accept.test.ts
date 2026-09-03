import assert from 'node:assert/strict'
import test from 'node:test'

import type { MeResponse } from '@nessie/schemas'
import { JSDOM } from 'jsdom'

import { stubResizeObserver } from './support/resize-observer-stub'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/channels',
})
stubResizeObserver(dom.window as unknown as Window & typeof globalThis)

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { MemoryRouter, useLocation } = await import('react-router-dom')
const { ApiClientProvider } = await import('../src/providers/ApiClientProvider.js')
const { AuthSessionProvider } = await import('../src/providers/AuthSessionProvider.js')
const { ThemeProvider } = await import('../src/providers/ThemeProvider.js')
const { TransientMenuProvider } = await import(
  '../src/layouts/admin-shell/TransientMenuContext.js'
)
const { TeamSwitcher } = await import('../src/layouts/admin-shell/TeamSwitcher.js')

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const currentMe: MeResponse = {
  auth: {
    autoRedirectToSso: false,
    providerId: 'uoa',
    providerType: 'uoa',
  },
  context: {
    bootstrapMode: false,
    organizationId: '11111111-1111-1111-1111-111111111111',
    projectId: '22222222-2222-2222-2222-222222222222',
    teamId: '33333333-3333-3333-3333-333333333333',
  },
  session: {
    issuedAt: '2026-08-31T12:00:00.000Z',
    sessionId: 'session-1',
  },
  uoaPendingInvites: [{
    inviteId: 'invite-1',
    invitedBy: 'Alice',
    organizationId: 'uoa-org-2',
    teamId: 'uoa-team-2',
    teamName: 'Launch Crew',
  }],
  uoaTeams: [{
    active: true,
    label: 'Home',
    organizationId: 'uoa-org-1',
    teamId: 'uoa-team-1',
  }],
  user: {
    displayName: 'Invited Person',
    email: 'invited@example.test',
    id: '44444444-4444-4444-4444-444444444444',
    roleIds: ['member'],
    superAdmin: false,
  },
}

const switchedMe: MeResponse = {
  ...currentMe,
  context: {
    ...currentMe.context,
    organizationId: '55555555-5555-5555-5555-555555555555',
    teamId: '66666666-6666-6666-6666-666666666666',
  },
  uoaPendingInvites: [],
  uoaTeams: [{
    active: true,
    label: 'Launch Crew',
    organizationId: 'uoa-org-2',
    teamId: 'uoa-team-2',
  }],
}

type FetchCall = {
  body: unknown
  method: string
  path: string
}

const jsonResponse = (data: unknown): Response => new Response(
  JSON.stringify({ data }),
  { headers: { 'content-type': 'application/json' }, status: 200 },
)

const LocationProbe = () => {
  const location = useLocation()
  return h('output', { 'data-location': location.pathname })
}

const installDom = () => {
  const values = {
    document: dom.window.document,
    Element: dom.window.Element,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
    MouseEvent: dom.window.MouseEvent,
    navigator: dom.window.navigator,
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
  }
}

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

test('the team switcher accepts a pending invitation and enters that team', async () => {
  const restoreDom = installDom()
  const previousFetch = globalThis.fetch
  const calls: FetchCall[] = []
  dom.window.localStorage.setItem('nessie.admin.token', 'current-token')
  dom.window.localStorage.setItem(
    'nessie.admin.token-mode',
    JSON.stringify({ mode: 'renewable', token: 'current-token' }),
  )
  globalThis.fetch = async (input, init) => {
    const path = typeof input === 'string' ? input : input.url
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null
    calls.push({ body, method, path })
    if (path === '/api/auth/me') return jsonResponse(currentMe)
    if (path === '/api/auth/providers') return jsonResponse([])
    if (path === '/api/team/invitations/invite-1/accept') {
      return jsonResponse({ ok: true, organizationId: 'uoa-org-2', teamId: 'uoa-team-2' })
    }
    if (path === '/api/auth/uoa/team') {
      return jsonResponse({ me: switchedMe, token: 'switched-token' })
    }
    return new Response('unexpected request', { status: 500 })
  }

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        h(
          QueryClientProvider,
          { client: queryClient },
          h(
            AuthSessionProvider,
            null,
            h(
              ApiClientProvider,
              null,
              h(
                ThemeProvider,
                null,
                h(
                  MemoryRouter,
                  { initialEntries: ['/settings'] },
                  h(
                    TransientMenuProvider,
                    null,
                    h(TeamSwitcher),
                    h(LocationProbe),
                  ),
                ),
              ),
            ),
          ),
        ),
      )
    })
    await settle()

    const switchButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Switch team"]',
    )
    assert.ok(switchButton)
    await act(async () => switchButton.click())
    await settle()

    // The team menu is a Popover, and every overlay portals out of the
    // tree it was declared in (components/overlays/OverlayPortal.tsx), so the
    // menu is read from the document rather than from `container`.
    const menu = dom.window.document.body
    assert.match(menu.textContent ?? '', /Invitations/)
    assert.match(menu.textContent ?? '', /Launch Crew/)
    assert.match(menu.textContent ?? '', /Invited by Alice/)

    const acceptButton = [...menu.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Accept',
    )
    assert.ok(acceptButton)
    await act(async () => acceptButton.click())
    await settle()
    await settle()

    assert.deepEqual(
      calls.find((call) => call.path.endsWith('/invite-1/accept')),
      {
        body: { organizationId: 'uoa-org-2', teamId: 'uoa-team-2' },
        method: 'POST',
        path: '/api/team/invitations/invite-1/accept',
      },
    )
    assert.deepEqual(
      calls.find((call) => call.path === '/api/auth/uoa/team'),
      {
        body: { organizationId: 'uoa-org-2', teamId: 'uoa-team-2' },
        method: 'POST',
        path: '/api/auth/uoa/team',
      },
    )
    assert.equal(container.querySelector('output')?.getAttribute('data-location'), '/channels')
    assert.equal(dom.window.localStorage.getItem('nessie.admin.token'), 'switched-token')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    queryClient.clear()
    dom.window.localStorage.clear()
    globalThis.fetch = previousFetch
    restoreDom()
  }
})
