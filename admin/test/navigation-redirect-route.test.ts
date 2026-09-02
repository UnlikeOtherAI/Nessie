import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const settle = async (act: (callback: () => Promise<void>) => Promise<void>): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

test('router.tsx redirects through RedirectRoute, never a bare Navigate', () => {
  const source = readFileSync(new URL('../src/router.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /<Navigate\b/)
  assert.doesNotMatch(source, /\bNavigate\b[^a-zA-Z]/)
  assert.match(source, /<RedirectRoute to=/)
})

test('a redirect replaces and forwards the location state it arrived with', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'https://app.example/',
  })
  const values = {
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: dom.window.navigator,
    window: dom.window,
  }
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  const React = await import('react')
  const { act, createElement: h } = React
  const { createRoot } = await import('react-dom/client')
  const { createMemoryRouter, RouterProvider, useLocation } = await import('react-router-dom')
  const { RedirectRoute } = await import('../src/navigation/RedirectRoute.js')
  ;(globalThis as typeof globalThis & { React: typeof React }).React = React

  const Probe = () => {
    const location = useLocation()
    return h('p', null, JSON.stringify(location.state))
  }
  const router = createMemoryRouter([
    { path: '/before', element: h('p', null, 'Before') },
    { path: '/work', element: h(RedirectRoute, { to: '/projects' }) },
    { path: '/projects', element: h(Probe) },
  ], {
    initialEntries: ['/before', { pathname: '/work', state: { returnTo: '/channels/c1' } }],
    initialIndex: 1,
  })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await act(async () => root.render(h(RouterProvider, { router })))
    await settle(act)

    assert.equal(router.state.location.pathname, '/projects')
    assert.deepEqual(router.state.location.state, { returnTo: '/channels/c1' })
    assert.equal(container.textContent, JSON.stringify({ returnTo: '/channels/c1' }))
    // Replaced, not pushed: Back from the destination returns to /before.
    await act(async () => { await router.navigate(-1) })
    await settle(act)
    assert.equal(router.state.location.pathname, '/before')
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
})
