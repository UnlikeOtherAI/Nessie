import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/login',
})

const installDom = () => {
  const values = {
    document: dom.window.document,
    Element: dom.window.Element,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
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

const jsonResponse = (data: unknown): Response => new Response(
  JSON.stringify({ data }),
  { headers: { 'content-type': 'application/json' }, status: 200 },
)

const settle = async (act: (callback: () => Promise<void>) => Promise<void>): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

test('a browser Back return clears its pending SSO attempt and does not re-launch automatically', async () => {
  const restoreDom = installDom()
  const previousFetch = globalThis.fetch
  let authorizeRequests = 0

  const React = await import('react')
  const { act, createElement: h } = React
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter } = await import('react-router-dom')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const { AuthSessionProvider } = await import('../src/providers/AuthSessionProvider.js')
  const { ApiClientProvider } = await import('../src/providers/ApiClientProvider.js')
  const { ThemeProvider } = await import('../src/providers/ThemeProvider.js')
  const { LoginPage } = await import('../src/pages/LoginPage.js')
  const {
    beginExternalAuth,
    clearPendingExternalAuth,
    readPendingExternalAuth,
  } = await import('../src/lib/pkce.js')

  // The production Vite transform injects the JSX runtime. Node's lightweight
  // tsx loader uses the classic transform for imported TSX modules.
  ;(globalThis as typeof globalThis & { React: typeof React }).React = React

  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, dom.window.location.origin)
    if (url.pathname === '/api/auth/me' || url.pathname === '/api/auth/refresh') {
      return new Response(null, { status: 401 })
    }
    if (url.pathname === '/api/auth/providers') {
      return jsonResponse([{
        autoRedirect: true,
        enabled: true,
        label: 'Sign in with SSO',
        providerId: 'uoa',
        type: 'uoa',
      }])
    }
    if (url.pathname === '/api/auth/providers/uoa/authorize') {
      authorizeRequests += 1
      return jsonResponse({ authorizeUrl: 'https://idp.example.test/authorize' })
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
    await beginExternalAuth({
      providerId: 'uoa',
      redirectUri: 'http://localhost:5455/login',
      theme: 'daylight',
    })
    assert.ok(readPendingExternalAuth())

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
              h(ThemeProvider, null, h(MemoryRouter, null, h(LoginPage))),
            ),
          ),
        ),
      )
    })
    await settle(act)

    // A restored document has an unfinished PKCE state, but it must remain on
    // the login page rather than automatically cycling back to the provider.
    assert.equal(authorizeRequests, 1)

    const returned = new dom.window.Event('pageshow')
    Object.defineProperty(returned, 'persisted', { value: true })
    await act(async () => {
      dom.window.dispatchEvent(returned)
    })
    await settle(act)

    assert.equal(readPendingExternalAuth(), null)
    assert.match(container.textContent ?? '', /Sign in with SSO/)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    clearPendingExternalAuth()
    globalThis.fetch = previousFetch
    restoreDom()
  }
})

test('a back/forward restore retries a suspended session check instead of leaving the shell loading', async () => {
  const restoreDom = installDom()
  const previousFetch = globalThis.fetch
  let meRequests = 0

  const React = await import('react')
  const { act, createElement: h } = React
  const { createRoot } = await import('react-dom/client')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const { AuthSessionProvider, useAuthSession } = await import('../src/providers/AuthSessionProvider.js')

  ;(globalThis as typeof globalThis & { React: typeof React }).React = React

  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, dom.window.location.origin)
    if (url.pathname === '/api/auth/me') {
      meRequests += 1
      if (meRequests === 1) return new Promise<Response>(() => undefined)
      return new Response(null, { status: 401 })
    }
    if (url.pathname === '/api/auth/refresh') return new Response(null, { status: 401 })
    return new Response('unexpected request', { status: 500 })
  }

  const SessionState = () => h('output', { 'data-session-state': true }, useAuthSession().sessionState)
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
          h(AuthSessionProvider, null, h(SessionState)),
        ),
      )
    })
    await settle(act)
    assert.equal(container.querySelector('output')?.textContent, 'loading')

    const returned = new dom.window.Event('pageshow')
    Object.defineProperty(returned, 'persisted', { value: true })
    await act(async () => {
      dom.window.dispatchEvent(returned)
    })
    await settle(act)

    assert.equal(meRequests, 2)
    assert.equal(container.querySelector('output')?.textContent, 'unauthenticated')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = previousFetch
    restoreDom()
  }
})
