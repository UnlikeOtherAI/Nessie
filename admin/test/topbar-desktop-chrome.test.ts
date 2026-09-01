import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import * as ReactNamespace from 'react'

/**
 * The top bar doubles as the desktop title bar, and exactly one platform draws
 * its window controls on the left: macOS, where the OS puts the traffic lights
 * there and the bar has to leave them a 68px seat. Windows and Linux draw their
 * own controls on the right through DesktopWindowFrame, so keeping the spacer
 * off macOS would indent the whole bar past an empty corner.
 */

;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/channels',
})

dom.window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
  onchange: null,
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia

const domGlobals: Record<string, unknown> = {
  document: dom.window.document,
  Element: dom.window.Element,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage,
  navigator: dom.window.navigator,
  window: dom.window,
}

const { createElement: h } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { MemoryRouter } = await import('react-router-dom')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { ShellEnvironmentProvider } = await import('../src/providers/ShellEnvironmentProvider.js')
const { AuthSessionProvider } = await import('../src/providers/AuthSessionProvider.js')
const { ApiClientProvider } = await import('../src/providers/ApiClientProvider.js')
const { FocusModeProvider } = await import('../src/providers/FocusModeProvider.js')
const { TransientMenuProvider } = await import('../src/layouts/admin-shell/TransientMenuContext.js')
const { TopBar } = await import('../src/layouts/admin-shell/TopBar.js')

// Effects never run under renderToStaticMarkup, so the whole provider stack
// mounts without a single network call — the markup is the first paint.
const renderTopBar = (platform: 'linux' | 'macos' | 'windows' | null): string => {
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  const tauriWindow = dom.window as unknown as Record<string, unknown>
  if (platform) {
    tauriWindow.__TAURI__ = {}
    tauriWindow.__nessieDesktopPlatform = platform
  } else {
    delete tauriWindow.__TAURI__
    delete tauriWindow.__TAURI_INTERNALS__
    delete tauriWindow.__nessieDesktopPlatform
  }
  try {
    return renderToStaticMarkup(
      h(
        ShellEnvironmentProvider,
        null,
        h(
          QueryClientProvider,
          { client: new QueryClient() },
          h(
            AuthSessionProvider,
            null,
            h(
              ApiClientProvider,
              null,
              h(
                FocusModeProvider,
                null,
                h(
                  MemoryRouter,
                  { initialEntries: ['/channels'] },
                  h(
                    TransientMenuProvider,
                    null,
                    h(TopBar, { onLogout: () => undefined, showAccountMenu: false }),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    )
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
}

test('only macOS gets the traffic-light spacer', () => {
  assert.match(renderTopBar('macos'), /admin-topbar-drag-zone--traffic/)
  for (const platform of ['linux', 'windows', null] as const) {
    assert.doesNotMatch(
      renderTopBar(platform),
      /admin-topbar-drag-zone--traffic/,
      `${platform ?? 'web'} draws no traffic lights`,
    )
  }
})

test('every desktop shell keeps its title-bar drag zones; the web build has none', () => {
  for (const platform of ['linux', 'macos', 'windows'] as const) {
    const html = renderTopBar(platform)
    assert.match(html, /admin-topbar--desktop/, `${platform} is in title-bar mode`)
    assert.ok(
      (html.match(/data-tauri-drag-region/g) ?? []).length >= 2,
      `${platform} keeps drag zones around the interactive controls`,
    )
  }
  const web = renderTopBar(null)
  assert.doesNotMatch(web, /admin-topbar--desktop/)
  assert.doesNotMatch(web, /data-tauri-drag-region/)
})
