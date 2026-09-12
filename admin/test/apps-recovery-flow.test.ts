import assert from 'node:assert/strict'
import test from 'node:test'

import type { ApiClient } from '@nessie/client-core'
import type { AppConnectionSummaryRecord, AppSummaryRecord } from '@nessie/schemas'
import { JSDOM } from 'jsdom'

const app: AppSummaryRecord = {
  aliases: [],
  appSource: 'nessie',
  authMethod: 'oauth2',
  categories: ['development'],
  connectionCount: 1,
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
  state: 'auth_expired',
  tags: [],
  toolCount: null,
  trustLevel: 'verified',
  vendor: 'KiloMayo',
}

const connection: AppConnectionSummaryRecord = {
  canDisconnect: false,
  canReconnect: true,
  canRefreshCapabilities: false,
  displayName: 'Just me',
  errorMessage: 'The sign-in for KiloSupport is no longer valid. Reconnect to keep using it.',
  id: '22222222-2222-2222-2222-222222222222',
  lastConnectedAt: null,
  scopeId: '33333333-3333-3333-3333-333333333333',
  scopeType: 'user',
  status: 'expired',
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/apps/kilo-support',
})
const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { ApiClientProvider } = await import('@nessie/client-core')

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const { AppConnectDialog } = await import('../src/components/features/apps/AppConnectDialog.js')

const installDom = () => {
  const values = {
    document: dom.window.document,
    Element: dom.window.Element,
    Event: dom.window.Event,
    EventTarget: dom.window.EventTarget,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
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

test('expired-account recovery calls the existing row endpoint and never starts a new connection', async () => {
  const restoreDom = installDom()
  const calls: Array<{ body: unknown; path: string }> = []
  const apiClient = {
    delete: async () => undefined,
    get: async () => [],
    patch: async () => undefined,
    post: async (path: string, body: unknown) => {
      calls.push({ body, path })
      return { connectionId: connection.id, status: 'connected' }
    },
    put: async () => undefined,
  } as unknown as ApiClient
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
            ApiClientProvider,
            { client: apiClient },
            h(AppConnectDialog, {
              app,
              onClose: () => undefined,
              open: true,
              reconnectConnection: connection,
            }),
          ),
        ),
      )
    })
    await settle()

    assert.deepEqual(calls, [{
      body: {},
      path: `/api/app-connections/${connection.id}/reconnect`,
    }])
  } finally {
    await act(async () => root.unmount())
    container.remove()
    queryClient.clear()
    restoreDom()
  }
})
