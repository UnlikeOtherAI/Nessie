import assert from 'node:assert/strict'
import test from 'node:test'

import type { ApiClient } from '@nessie/client-core'
import type { AppSummaryRecord } from '@nessie/schemas'
import { JSDOM } from 'jsdom'

import {
  appConnectScopeCopy,
  buildAppConnectScope,
  canShareAppConnectionKey,
} from '../src/components/features/apps/app-connect-scope.js'
import { channelKeys } from '../src/lib/query-keys.js'
import type { ChannelRecord } from '../src/lib/api-client.js'

const CHANNEL_ID = '22222222-2222-2222-2222-222222222222'

const app: AppSummaryRecord = {
  aliases: [],
  appSource: 'nessie',
  authMethod: 'api_key',
  categories: ['development'],
  connectionCount: 0,
  displayName: 'KiloSupport',
  distribution: 'remote',
  featured: false,
  featuredOrder: null,
  iconUrl: null,
  id: '11111111-1111-1111-1111-111111111111',
  locked: false,
  managedByIntegration: false,
  name: 'kilo-support',
  primaryCategory: 'development',
  promptCount: null,
  resourceCount: null,
  shortDescription: 'Support API',
  slug: 'kilo-support',
  state: 'available',
  tags: [],
  toolCount: null,
  trustLevel: 'verified',
  vendor: 'KiloMayo',
}

const channel: ChannelRecord = {
  createdAt: '2026-09-01T12:00:00.000Z',
  defaultThreadId: '33333333-3333-3333-3333-333333333333',
  id: CHANNEL_ID,
  label: 'Customer support',
  lastMessageAt: null,
  organizationId: '44444444-4444-4444-4444-444444444444',
  projectId: '55555555-5555-5555-5555-555555555555',
  projectName: 'Operations',
  scope: 'project',
  teamId: '66666666-6666-6666-6666-666666666666',
  teamName: 'Support',
  type: 'standard',
  unreadCount: 0,
  updatedAt: '2026-09-01T12:00:00.000Z',
  visibility: 'private',
}

test('personal remains the default scope and a channel needs an explicit id', () => {
  assert.deepEqual(buildAppConnectScope('user', CHANNEL_ID), { scopeType: 'user' })
  assert.deepEqual(buildAppConnectScope('channel', CHANNEL_ID), {
    scopeId: CHANNEL_ID,
    scopeType: 'channel',
  })
  assert.equal(buildAppConnectScope('channel', ''), null)
  assert.equal(
    appConnectScopeCopy('user'),
    'Just you. You can choose which agents may use it after it connects.',
  )
  assert.equal(
    appConnectScopeCopy('channel', channel.label),
    'A separate connection will be created for Customer support. You will add your own credential; only agents acting in that channel can use this connection.',
  )
})

test('only a non-personal API-key connection offers a shared key', () => {
  assert.equal(canShareAppConnectionKey('api_key', 'channel'), true)
  assert.equal(canShareAppConnectionKey('api_key', 'user'), false)
  assert.equal(canShareAppConnectionKey('oauth2', 'channel'), false)
  assert.equal(canShareAppConnectionKey('bearer', 'channel'), false)
})

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/apps/kilo-support',
})

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { ApiClientProvider } = await import('@nessie/client-core')

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const { AppConnectDialog } = await import('../src/components/features/apps/AppConnectDialog.js')

type ConnectCall = { body: unknown; path: string }

const installDom = () => {
  const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    'scrollIntoView',
  )
  if (scrollIntoViewDescriptor === undefined) {
    Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: () => undefined,
      writable: true,
    })
  }
  const values = {
    document: dom.window.document,
    Element: dom.window.Element,
    Event: dom.window.Event,
    EventTarget: dom.window.EventTarget,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MouseEvent: dom.window.MouseEvent,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    sessionStorage: dom.window.sessionStorage,
    window: dom.window,
  }
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  return () => {
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(
        dom.window.HTMLElement.prototype,
        'scrollIntoView',
        scrollIntoViewDescriptor,
      )
    } else {
      Reflect.deleteProperty(dom.window.HTMLElement.prototype, 'scrollIntoView')
    }
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const mount = async () => {
  const restoreDom = installDom()
  const calls: ConnectCall[] = []
  const apiClient = {
    delete: async () => undefined,
    get: async () => [channel],
    patch: async () => undefined,
    post: async (path: string, body: unknown) => {
      calls.push({ body, path })
      return { connectionId: '77777777-7777-7777-7777-777777777777', status: 'connected' }
    },
    put: async () => undefined,
  } as unknown as ApiClient
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(channelKeys.all, [channel])
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
          h(AppConnectDialog, { app, onClose: () => undefined, open: true }),
        ),
      ),
    )
  })
  await settle()

  return {
    calls,
    container,
    // The dialog portals out of `container`
    // (components/overlays/OverlayPortal.tsx), so what it rendered is read
    // from the document rather than from the element it was mounted in.
    scope: dom.window.document.body,
    unmount: async () => {
      await act(async () => root.unmount())
      container.remove()
      queryClient.clear()
      restoreDom()
    },
  }
}

test('the dialog posts personal scope by default and only posts channel scope after selection', async () => {
  const harness = await mount()

  try {
    const confirm = harness.scope.querySelector<HTMLButtonElement>(
      '[data-testid="app-connect-confirm"]',
    )
    assert.ok(confirm)
    assert.equal(confirm.disabled, false)
    assert.equal(harness.scope.querySelector('[data-testid="app-connect-channel-picker"]'), null)
    assert.match(harness.scope.textContent ?? '', /Just you\. You can choose which agents may use it/)

    await act(async () => confirm.click())
    await settle()
    assert.deepEqual(harness.calls[0], {
      body: { scopeType: 'user' },
      path: '/api/apps/kilo-support/connect',
    })
  } finally {
    await harness.unmount()
  }

  const channelHarness = await mount()
  try {
    const chooseChannel = channelHarness.scope.querySelector<HTMLButtonElement>(
      '[data-testid="app-connect-scope-channel"]',
    )
    assert.ok(chooseChannel)
    await act(async () => chooseChannel.click())
    await settle()

    const confirm = channelHarness.scope.querySelector<HTMLButtonElement>(
      '[data-testid="app-connect-confirm"]',
    )
    const picker = channelHarness.scope.querySelector<HTMLSelectElement>(
      '[data-testid="app-connect-channel-picker"]',
    )
    assert.ok(confirm)
    assert.ok(picker)
    assert.equal(confirm.disabled, true)
    assert.match(channelHarness.scope.textContent ?? '', /Select a channel\./)

    picker.value = CHANNEL_ID
    await act(async () => {
      picker.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    assert.equal(confirm.disabled, false)
    assert.match(
      channelHarness.scope.textContent ?? '',
      /A separate connection will be created for Customer support\./,
    )
    assert.match(channelHarness.scope.textContent ?? '', /You will add your own credential/)
    assert.match(channelHarness.scope.textContent ?? '', /only agents acting in that channel can use this connection\./)

    await act(async () => confirm.click())
    await settle()
    assert.deepEqual(channelHarness.calls[0], {
      body: { scopeId: CHANNEL_ID, scopeType: 'channel' },
      path: '/api/apps/kilo-support/connect',
    })
  } finally {
    await channelHarness.unmount()
  }
})
