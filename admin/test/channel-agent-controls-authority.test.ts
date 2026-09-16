import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AgentRecord, UserRecord } from '../src/lib/api-client'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

import { ChannelMembersPopup } from '../src/components/shared/ChannelMembersPopup'
import { AuthSessionProvider } from '../src/providers/AuthSessionProvider'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

// `AuthSessionProvider` reads a stored token on its first render; the avatar
// components below need its context, so the popup cannot be rendered without
// one. A bare in-memory shim is enough — nothing here reads a real session.
//
// Installed only when nothing else has: the admin suite runs with
// `--experimental-test-isolation=none`, so every test file shares one global,
// and `ambient-refresh-gate.test.ts` installs a stub whose reads and writes it
// makes throw on demand. Clobbering that one made three of its cases pass
// silently against the wrong object.
if (!('localStorage' in globalThis)) {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size },
    removeItem: (key: string) => { store.delete(key) },
    setItem: (key: string, value: string) => { store.set(key, value) },
  }
}

const VIEWER = '11111111-1111-4111-8111-111111111111'

const user = (id: string, name: string): UserRecord =>
  ({ displayName: name, email: `${name}@example.com`, id } as unknown as UserRecord)

const agent = (id: string, name: string): AgentRecord =>
  ({
    id,
    name,
    role: 'assistant',
    status: 'idle',
    systemManaged: false,
    visibility: 'team',
  } as unknown as AgentRecord)

const stubClient = {
  delete: async () => ({ ok: true }),
  get: async () => null,
  patch: async () => ({ ok: true }),
  post: async () => ({ ok: true }),
  put: async () => ({ ok: true }),
} as unknown as ApiClient

const BOUND = agent('22222222-2222-4222-8222-222222222222', 'Bound agent')
const AVAILABLE = agent('33333333-3333-4333-8333-333333333333', 'Available agent')

const render = (overrides: {
  viewerCanManage?: boolean
  viewerCanManageAgents?: boolean
  channelUsers?: UserRecord[]
} = {}): string =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(
      AuthSessionProvider,
      null,
      createElement(
      ApiClientProvider,
      { client: stubClient },
      createElement(
      MemoryRouter,
      { initialEntries: ['/'] },
      createElement(ChannelMembersPopup, {
        allAgents: [BOUND, AVAILABLE],
        allUsers: [user(VIEWER, 'Viewer'), user('44444444-4444-4444-8444-444444444444', 'Colleague')],
        boundAgents: [BOUND],
        channelId: '55555555-5555-4555-8555-555555555555',
        channelLabel: 'sales',
        channelUsers: overrides.channelUsers ?? [user(VIEWER, 'Viewer')],
        currentUserId: VIEWER,
        personalAssistantPresences: [],
        viewerCanManage: overrides.viewerCanManage ?? true,
        viewerCanManageAgents: overrides.viewerCanManageAgents ?? false,
        onClose: () => {},
        onSelectAgent: () => {},
      }),
      ),
      ),
      ),
    ),
  )

test('an owner gets the agent Add and Remove controls', () => {
  const html = render({ viewerCanManageAgents: true })
  assert.match(html, /data-testid="channel-agent-add"/)
  assert.match(html, /data-testid="channel-agent-remove"/)
})

test('a member who may manage the channel still gets no agent Add or Remove', () => {
  // The exact shape of the reported defect: `viewerCanManage` is true (any
  // member of the channel), the binding routes still refuse, so neither agent
  // control may be drawn.
  const html = render({ viewerCanManage: true, viewerCanManageAgents: false })
  assert.doesNotMatch(html, /data-testid="channel-agent-add"/)
  assert.doesNotMatch(html, /data-testid="channel-agent-remove"/)
  // The people rows beside them are untouched: adding a person really is any
  // member of the channel, and that authority has not changed.
  assert.match(html, /Colleague/)

  // The rows themselves stay: seeing which agents are in a channel, and
  // copying one, are wider permissions than placing one.
  assert.match(html, /Bound agent/)
  assert.match(html, /Available agent/)
  assert.match(html, /title="Create a copy you own"/)
})

test('the personal assistant offer is withheld from somebody who has not joined', () => {
  // Its route resolves the channel through `getChannelIfMember`, and the
  // header offers Members on an unjoined public channel.
  assert.match(render({ channelUsers: [user(VIEWER, 'Viewer')] }), /data-testid="channel-pa-offer"/)
  assert.doesNotMatch(
    render({ channelUsers: [user('44444444-4444-4444-8444-444444444444', 'Colleague')] }),
    /data-testid="channel-pa-offer"/,
  )
})
