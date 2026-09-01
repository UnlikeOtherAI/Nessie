import assert from 'node:assert/strict'
import test from 'node:test'

import type { ApiClient } from '@nessie/client-core'
import { JSDOM } from 'jsdom'

import { appKeys } from '../src/lib/query-keys.js'
import {
  createAppConnectAuthorizationLauncher,
  type AppConnectFlow,
  useAppConnectFlow,
} from '../src/facades/apps/connect-hooks.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'https://app.nessie.example/apps/github',
})

const React = await import('react')
const { act, createElement: h, useEffect } = React
const { createRoot } = await import('react-dom/client')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { ApiClientProvider } = await import('@nessie/client-core')

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const installDom = () => {
  const values = {
    CustomEvent: dom.window.CustomEvent,
    document: dom.window.document,
    Element: dom.window.Element,
    Event: dom.window.Event,
    EventTarget: dom.window.EventTarget,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
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
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const FlowHarness = ({ onFlow }: { onFlow: (flow: AppConnectFlow) => void }) => {
  const flow = useAppConnectFlow({ slug: 'github' })
  useEffect(() => onFlow(flow), [flow, onFlow])
  return null
}

test('browser web retains the centred popup launcher', () => {
  const calls: { features: string; target: string; url: string }[] = []
  const launcher = createAppConnectAuthorizationLauncher({
    open: (url, target, features) => {
      calls.push({ features, target, url })
      return { closed: false, close: () => undefined, focus: () => undefined }
    },
    outerHeight: 1_000,
    outerWidth: 1_400,
    screenX: 0,
    screenY: 0,
  }, false)

  assert.ok(launcher.open('https://idp.example/authorize'))
  assert.deepEqual(calls[0], {
    features: 'width=600,height=760,left=400,top=120,resizable=yes,scrollbars=yes',
    target: 'nessie-connect',
    url: 'https://idp.example/authorize',
  })
})

test('native connector authorization stays in the WebView and rechecks on foreground', async () => {
  const restoreDom = installDom()
  const nativeWindow = dom.window as typeof dom.window & {
    ReactNativeWebView?: { postMessage: (data: string) => void }
  }
  const bridgeMessages: string[] = []
  let appStatusReads = 0
  let connectionStatus = 'pending_setup'
  let flow: AppConnectFlow | null = null
  let popupAttempted = false
  const originalOpen = dom.window.open
  nativeWindow.ReactNativeWebView = { postMessage: (message) => bridgeMessages.push(message) }
  dom.window.open = () => {
    popupAttempted = true
    return null
  }
  dom.window.sessionStorage.clear()

  const apiClient = {
    delete: async () => undefined,
    get: async (path: string) => {
      assert.equal(path, '/api/apps/github')
      appStatusReads += 1
      return {
        connections: [{ id: 'connection-1', status: connectionStatus }],
      }
    },
    patch: async () => undefined,
    post: async (path: string) => {
      assert.equal(path, '/api/apps/github/connect')
      return {
        authorizationUrl: 'https://idp.example/authorize?state=connector-state',
        connectionId: 'connection-1',
        status: 'authorize',
      }
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
          h(ApiClientProvider, { client: apiClient }, h(FlowHarness, { onFlow: (next) => { flow = next } })),
        ),
      )
    })
    assert.ok(flow)

    await act(async () => flow?.connect({ scopeType: 'user' }))
    await settle()

    assert.equal(popupAttempted, false)
    assert.deepEqual(bridgeMessages.map((message) => JSON.parse(message)), [{
      authorizationUrl: 'https://idp.example/authorize?state=connector-state',
      type: 'nessie:connector-authorization',
    }])
    assert.equal(flow?.state.phase, 'awaiting_authorization')

    await act(async () => flow?.reopenAuthorization())
    assert.deepEqual(bridgeMessages.map((message) => JSON.parse(message)), [
      {
        authorizationUrl: 'https://idp.example/authorize?state=connector-state',
        type: 'nessie:connector-authorization',
      },
      {
        authorizationUrl: 'https://idp.example/authorize?state=connector-state',
        type: 'nessie:connector-authorization',
      },
    ])

    const readsBeforeForeground = appStatusReads

    await act(async () => {
      dom.window.dispatchEvent(new dom.window.CustomEvent('nessie:native-app-foreground', {
        detail: false,
      }))
    })
    await settle()
    assert.equal(appStatusReads, readsBeforeForeground)

    connectionStatus = 'connected'
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.CustomEvent('nessie:native-app-foreground', {
        detail: true,
      }))
    })
    await settle()

    assert.equal(appStatusReads, readsBeforeForeground + 1)
    assert.equal(flow?.state.phase, 'connected')
    assert.equal(
      queryClient.getQueryData<{ connections: { status: string }[] }>(appKeys.detail('github'))
        ?.connections[0]?.status,
      'connected',
    )
  } finally {
    await act(async () => root.unmount())
    container.remove()
    queryClient.clear()
    dom.window.open = originalOpen
    delete nativeWindow.ReactNativeWebView
    restoreDom()
  }
})
