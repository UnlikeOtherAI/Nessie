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
    CustomEvent: dom.window.CustomEvent,
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

test('a native SSO launch releases the login button after posting to the shell', async () => {
  const restoreDom = installDom()
  const previousFetch = globalThis.fetch
  const nativeWindow = dom.window as typeof dom.window & {
    ReactNativeWebView?: { postMessage: (data: string) => void }
  }
  const posted: string[] = []
  nativeWindow.ReactNativeWebView = { postMessage: (message) => posted.push(message) }

  const React = await import('react')
  const { act, createElement: h } = React
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter } = await import('react-router-dom')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const { AuthSessionProvider } = await import('../src/providers/AuthSessionProvider.js')
  const { ApiClientProvider } = await import('../src/providers/ApiClientProvider.js')
  const { ThemeProvider } = await import('../src/providers/ThemeProvider.js')
  const { LoginPage } = await import('../src/pages/LoginPage.js')
  const { clearPendingExternalAuth } = await import('../src/lib/pkce.js')

  ;(globalThis as typeof globalThis & { React: typeof React }).React = React
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, dom.window.location.origin)
    if (url.pathname === '/api/auth/me' || url.pathname === '/api/auth/refresh') {
      return new Response(null, { status: 401 })
    }
    if (url.pathname === '/api/auth/providers') {
      return jsonResponse([{
        autoRedirect: false,
        enabled: true,
        label: 'Sign in with SSO',
        providerId: 'uoa',
        type: 'uoa',
      }])
    }
    if (url.pathname === '/api/auth/providers/uoa/authorize') {
      return jsonResponse({ authorizeUrl: 'https://idp.example.test/authorize' })
    }
    return new Response('unexpected request', { status: 500 })
  }

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

    const button = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === 'Sign in with SSO',
    )
    assert.ok(button)
    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    await settle(act)

    assert.equal(posted.length, 1)
    assert.match(posted[0] ?? '', /"type":"nessie:external-auth"/)
    assert.equal(button.textContent, 'Sign in with SSO')
    assert.equal(button.hasAttribute('disabled'), false)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    clearPendingExternalAuth()
    delete nativeWindow.ReactNativeWebView
    globalThis.fetch = previousFetch
    restoreDom()
  }
})

test('expired and malformed native callbacks show a terminal notice and settle the bridge', async () => {
  const restoreDom = installDom()
  const previousFetch = globalThis.fetch
  const nativeWindow = dom.window as typeof dom.window & {
    ReactNativeWebView?: { postMessage: (data: string) => void }
    __nessieExternalAuthCallback?: (url: string) => Promise<void>
  }
  nativeWindow.ReactNativeWebView = { postMessage: () => undefined }

  const React = await import('react')
  const { act, createElement: h, useEffect } = React
  const { createRoot } = await import('react-dom/client')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const { clearPendingExternalAuth } = await import('../src/lib/pkce.js')
  const { NATIVE_EXTERNAL_AUTH_EVENT } = await import('../src/lib/native-external-auth.js')
  const { AuthSessionProvider } = await import('../src/providers/AuthSessionProvider.js')
  const { ExternalAuthProvider } = await import('../src/providers/ExternalAuthProvider.js')
  const { useExternalAuthNavigation } = await import('../src/providers/external-auth-navigation.js')

  ;(globalThis as typeof globalThis & { React: typeof React }).React = React
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, dom.window.location.origin)
    if (url.pathname === '/api/auth/me' || url.pathname === '/api/auth/refresh') {
      return new Response(null, { status: 401 })
    }
    return new Response('unexpected request', { status: 500 })
  }

  const navigated: string[] = []
  const NativeNavigation = (): null => {
    const navigation = useExternalAuthNavigation()
    useEffect(() => navigation?.registerNavigate((path) => navigated.push(path)), [navigation])
    return null
  }
  const terminalEvents: unknown[] = []
  const onTerminal = (event: Event): void => {
    terminalEvents.push((event as CustomEvent<unknown>).detail)
  }
  dom.window.addEventListener(NATIVE_EXTERNAL_AUTH_EVENT, onTerminal)
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
            AuthSessionProvider,
            null,
            h(ExternalAuthProvider, null, h(NativeNavigation)),
          ),
        ),
      )
    })
    await settle(act)

    const callback = nativeWindow.__nessieExternalAuthCallback
    assert.ok(callback)
    await act(async () => {
      await callback('nessie://auth/callback?code=expired')
      await callback('nessie://auth/not-a-callback?code=malformed')
    })
    await settle(act)

    assert.match(container.textContent ?? '', /Sign-in expired, please try again\./)
    assert.deepEqual(navigated, ['/login', '/login'])
    assert.deepEqual(terminalEvents, [
      { message: 'Sign-in expired, please try again.', type: 'failed' },
      { message: 'Sign-in expired, please try again.', type: 'failed' },
    ])
  } finally {
    await act(async () => root.unmount())
    container.remove()
    dom.window.removeEventListener(NATIVE_EXTERNAL_AUTH_EVENT, onTerminal)
    clearPendingExternalAuth()
    delete nativeWindow.ReactNativeWebView
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

test('a failed provider discovery explains the failure and lets the person retry', async () => {
  const restoreDom = installDom()
  const previousFetch = globalThis.fetch
  let providerRequests = 0

  const React = await import('react')
  const { act, createElement: h } = React
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter } = await import('react-router-dom')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const { AuthSessionProvider } = await import('../src/providers/AuthSessionProvider.js')
  const { ApiClientProvider } = await import('../src/providers/ApiClientProvider.js')
  const { ThemeProvider } = await import('../src/providers/ThemeProvider.js')
  const { LoginPage } = await import('../src/pages/LoginPage.js')

  ;(globalThis as typeof globalThis & { React: typeof React }).React = React
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, dom.window.location.origin)
    if (url.pathname === '/api/auth/me' || url.pathname === '/api/auth/refresh') {
      return new Response(null, { status: 401 })
    }
    if (url.pathname === '/api/auth/providers') {
      providerRequests += 1
      if (providerRequests === 1) throw new Error('Network request failed')
      return jsonResponse([{
        autoRedirect: false,
        enabled: true,
        label: 'Sign in with SSO',
        providerId: 'uoa',
        type: 'uoa',
      }])
    }
    return new Response('unexpected request', { status: 500 })
  }

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

    assert.match(container.textContent ?? '', /Couldn't load sign-in options/)
    assert.doesNotMatch(container.textContent ?? '', /Loading providers/)
    const retry = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === 'Retry loading sign-in options',
    )
    assert.ok(retry)

    await act(async () => {
      retry.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    await settle(act)

    assert.equal(providerRequests, 2)
    assert.match(container.textContent ?? '', /Sign in with SSO/)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = previousFetch
    restoreDom()
  }
})
