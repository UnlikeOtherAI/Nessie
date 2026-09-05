import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { JSDOM } from 'jsdom'
import * as ReactNamespace from 'react'

/**
 * Back from an app returns to the catalogue the person left
 * (docs/navigation/overview.md §4).
 *
 * Two faults on the same path made a reader who switched to All, opened a
 * card and pressed Back land on **Installed**:
 *
 *   - the detail page navigated to a bare `/apps`, throwing away the `?filter=`
 *     that says which view those shelves are, and
 *   - the catalogue answered that bare address with the view it had remembered
 *     *at mount* — and the stack retains this screen beneath the detail and
 *     re-shows the same instance on the way back, so "at mount" was the view
 *     that was open when the page was last loaded, not the one last chosen.
 *
 * Both are asserted here through the rendered strip and the router's location,
 * never through the source text.
 */

;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/apps',
})

// The session provider reconciles against the API on mount. Nothing here is
// authenticated and no server is running, so answer it rather than let it open
// real sockets and schedule retries. Installed with the rest of the window.
const unauthenticated = (async () =>
  new Response('{}', { headers: { 'content-type': 'application/json' }, status: 401 })) as typeof fetch

// jsdom implements no matchMedia. Every `min-width` query answers true, which
// puts the shell on its widest band — the `split` layout, where the detail
// renders its own Back button beside the title and where this bug was
// reported. The narrow layout resolves the same action through the shared
// doorway instead.
dom.window.matchMedia ??= ((query: string) => ({
  addEventListener: () => {},
  addListener: () => {},
  dispatchEvent: () => false,
  matches: query.includes('min-width'),
  media: query,
  onchange: null,
  removeEventListener: () => {},
  removeListener: () => {},
})) as unknown as typeof window.matchMedia

// The header measures its action row across a frame, and the tab strip watches
// its own width: jsdom answers both, but only on the window object.
// The viewport store reads its thresholds from the `--breakpoint-*` custom
// properties the stylesheet emits; without them it falls back to the server
// snapshot, where every band is false and the shell reads as `single`.
for (const [name, value] of Object.entries({
  sm: '40rem',
  md: '48rem',
  lg: '64rem',
  xl: '80rem',
  '2xl': '96rem',
})) {
  dom.window.document.documentElement.style.setProperty(`--breakpoint-${name}`, value)
}

const domGlobals = {
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  document: dom.window.document,
  Element: dom.window.Element,
  fetch: unauthenticated,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  localStorage: dom.window.localStorage,
  MouseEvent: dom.window.MouseEvent,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  ResizeObserver: dom.window.ResizeObserver,
  window: dom.window,
}

// jsdom's visual pretence runs a frame loop that would hold the process open
// long after the assertions are done.
after(() => { dom.window.close() })


const React = await import('react')
const { act, createElement: h, Fragment } = React
const { createRoot } = await import('react-dom/client')
const { MemoryRouter, Route, Routes, useLocation, useNavigate } = await import('react-router-dom')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { ApiClientProvider } = await import('@nessie/client-core')
const { __resetViewportStore } = await import('../src/hooks/useViewport.js')
const { AuthSessionProvider } = await import('../src/providers/AuthSessionProvider.js')
const { AppsPage } = await import('../src/pages/AppsPage.js')
const { AppDetailPage } = await import('../src/pages/AppDetailPage.js')
const { PhoneNavigationProvider } = await import(
  '../src/layouts/admin-shell/PhoneNavigationProvider.js'
)

const app = (index: number, connections: number) => ({
  id: `00000000-0000-4000-8000-00000000000${index}`,
  slug: `app-${index}`,
  name: `App ${index}`,
  displayName: `App ${index}`,
  shortDescription: 'A catalogue entry.',
  vendor: 'Demo',
  iconUrl: null,
  primaryCategory: 'development',
  categories: ['development'],
  tags: [],
  aliases: [],
  trustLevel: 'verified',
  distribution: 'remote',
  authMethod: 'none',
  appSource: 'registry',
  featured: false,
  featuredOrder: null,
  toolCount: 0,
  resourceCount: 0,
  promptCount: 0,
  managedByIntegration: false,
  locked: false,
  connectionCount: connections,
  state: connections > 0 ? 'connected' : 'available',
})

const ALL = [app(1, 1), app(2, 0), app(3, 0)]
const INSTALLED = ALL.filter((entry) => entry.connectionCount > 0)

const catalogue = (installed: boolean) => ({
  apps: installed ? INSTALLED : ALL,
  featured: [],
  categories: [{ category: 'development', count: installed ? 1 : 3, label: 'Development' }],
  installedCount: INSTALLED.length,
  totalCount: ALL.length,
})

const client = {
  delete: async () => ({}),
  get: async (path: string) => {
    if (/^\/api\/apps\/[^?]/.test(path)) {
      return { ...ALL[0], capabilities: { tools: [] }, connections: [], agentsWithAccess: [] }
    }
    return catalogue(path.includes('installed=true'))
  },
  getPage: async () => ({ data: [], meta: {} }),
  patch: async () => ({}),
  post: async () => ({}),
  put: async () => ({}),
} as never

// The suite shares one process, so this window is installed for the length of
// a mount and taken back down again — a stray `window` or `localStorage` left
// on `globalThis` changes what unrelated tests see.
const mount = async (entries: string[], element: ReactNamespace.ReactElement) => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  // The viewport store is memoised per process and this suite shares one, so
  // bind it to this window rather than to whichever file rendered first.
  __resetViewportStore()

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  // `gcTime: 0` so no cache timer outlives the assertions and holds the test
  // process open.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retry: false } },
  })
  let location = ''
  let navigate: ((to: string) => void) | null = null

  const Probe = () => {
    const current = useLocation()
    location = `${current.pathname}${current.search}`
    navigate = useNavigate()
    return null
  }

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
          { client },
          h(
            MemoryRouter,
            { initialEntries: entries },
            h(PhoneNavigationProvider, null, h(Fragment, null, h(Probe), element)),
          ),
          ),
        ),
      ),
    )
  })
  // One turn for the stubbed catalogue request to resolve into the shelves.
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })

  const settle = async () => {
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
  }

  return {
    checkedFilter: (): string | null => {
      const radios = [...container.querySelectorAll('[data-testid="apps-filter"] [role="radio"]')]
      return radios.find((node) => node.getAttribute('aria-checked') === 'true')?.textContent
        ?? null
    },
    click: async (node: Element | null | undefined) => {
      assert.ok(node, 'expected the control to be rendered')
      await act(async () => {
        node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      await settle()
    },
    filterOption: (label: string): Element | undefined =>
      [...container.querySelectorAll('[data-testid="apps-filter"] [role="radio"]')].find((node) =>
        node.textContent?.startsWith(label),
      ),
    // The page's own Back, the control a wide layout renders beside the title.
    // (The narrow layout resolves the same action through the shell's shared
    // doorway, which is a component this bug never touched.)
    backButton: (): Element | undefined =>
      [...container.querySelectorAll('button')].find(
        (node) => node.getAttribute('aria-label') === 'Back to Apps',
      ),
    go: async (to: string) => {
      await act(async () => { navigate?.(to) })
      await settle()
    },
    location: () => location,
    unmount: async () => {
      await act(async () => { root.unmount() })
      container.remove()
      queryClient.clear()
      __resetViewportStore()
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

test('the catalogue answers a bare /apps with the view last chosen, not the one it opened on', async () => {
  // What a refresh on Installed leaves behind: the remembered view is
  // Installed and the URL says so.
  dom.window.localStorage.setItem('nessie.apps.filter', 'installed')
  const screen = await mount(['/apps?filter=installed'], h(
    Routes,
    null,
    h(Route, { element: h(AppsPage), path: '/apps' }),
  ))

  try {
    assert.match(screen.checkedFilter() ?? '', /^Installed/)

    await screen.click(screen.filterOption('All'))
    assert.match(screen.checkedFilter() ?? '', /^All/)

    // The address Back lands on when the ledger has no entry to pop. The same
    // screen instance is re-shown — the stack retains it — so a remembered
    // view frozen at mount would flip the strip back to Installed here.
    await screen.go('/apps')
    assert.match(screen.checkedFilter() ?? '', /^All/)
  } finally {
    await screen.unmount()
  }
})

test('Back from an app returns to the catalogue entry the reader left, filter and all', async () => {
  dom.window.localStorage.setItem('nessie.apps.filter', 'installed')
  const screen = await mount(['/apps?filter=all'], h(
    Routes,
    null,
    h(Route, { element: h(AppsPage), path: '/apps' }),
    h(Route, { element: h(AppDetailPage), path: '/apps/:slug' }),
  ))

  try {
    await screen.go('/apps/app-1')
    assert.equal(screen.location(), '/apps/app-1')

    await screen.click(screen.backButton())
    // Popped, not replaced with the bare parent address: `?filter=all` is the
    // reader's own state, and the catalogue reads it back.
    assert.equal(screen.location(), '/apps?filter=all')
    assert.match(screen.checkedFilter() ?? '', /^All/)
  } finally {
    await screen.unmount()
  }
})
