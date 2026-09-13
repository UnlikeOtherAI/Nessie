import assert from 'node:assert/strict'
import test from 'node:test'

import { CreateMemberInvitationRequestSchema } from '@nessie/schemas'
import { JSDOM } from 'jsdom'

import { stubResizeObserver } from './support/resize-observer-stub'

/**
 * The non-UOA team invite form (`TeamMembersSection`) posted the older
 * `{invites:[{email, teamRole}]}` bulk body to `POST /api/team/invitations`,
 * which validates the single-invite `CreateMemberInvitationRequestSchema` — so
 * every send from this form was a `400`, hidden because the form is reachable
 * only on a local, non-UOA session (2026-09-13 invitation e2e run, F8).
 *
 * The body is checked against the route's own schema rather than a copy of it,
 * so a future change to either side fails here instead of in production.
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/settings',
})
stubResizeObserver(dom.window as unknown as Window & typeof globalThis)

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { ApiClientProvider } = await import('@nessie/client-core')
const { useCreateTeamInvitation } = await import('../src/facades/users/team-members.js')

;(globalThis as typeof globalThis & { React: typeof React }).React = React

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

test('one address is sent as one single-invite request the route accepts', async () => {
  const sent: { path: string; body: unknown }[] = []
  const apiClient = {
    delete: async () => undefined,
    get: async () => undefined,
    post: async (path: string, body: unknown) => {
      sent.push({ body, path })
      return { ok: true }
    },
    put: async () => undefined,
  }

  const Harness = () => {
    const invite = useCreateTeamInvitation()
    return h('button', {
      onClick: () => {
        void invite.mutateAsync({ email: 'invitee@acme.test', teamRole: 'member' })
      },
      type: 'button',
    }, 'Send invitation')
  }

  const restoreDom = installDom()
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        h(
          QueryClientProvider,
          { client: queryClient },
          h(
            ApiClientProvider,
            { client: apiClient as unknown as Parameters<typeof ApiClientProvider>[0]['client'] },
            h(Harness),
          ),
        ),
      )
    })
    const button = container.querySelector('button')
    assert.ok(button)
    await act(async () => button.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    assert.equal(sent.length, 1, 'one address is one request')
    assert.equal(sent[0]?.path, '/api/team/invitations')
    // The route parses exactly this; `{invites:[…]}` does not survive it.
    assert.deepEqual(
      CreateMemberInvitationRequestSchema.parse(sent[0]?.body),
      { email: 'invitee@acme.test', teamRole: 'member' },
    )
    assert.ok(
      !Object.hasOwn(sent[0]?.body as Record<string, unknown>, 'invites'),
      'the retired bulk envelope is gone',
    )
  } finally {
    await act(async () => root.unmount())
    container.remove()
    queryClient.clear()
    restoreDom()
  }
})
