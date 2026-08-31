import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'

const settle = async (act: (callback: () => Promise<void>) => Promise<void>): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

test('the web callback replaces login with a dedicated completion screen', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'https://app.example/login?code=flow&state=state',
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
  const { createMemoryRouter, RouterProvider } = await import('react-router-dom')
  const { ExternalAuthCompletionPage } = await import(
    '../src/pages/ExternalAuthCompletionPage.js'
  )
  const { LoginRoute } = await import('../src/pages/LoginRoute.js')
  ;(globalThis as typeof globalThis & { React: typeof React }).React = React

  const router = createMemoryRouter([
    { path: '/before', element: h('p', null, 'Before sign-in') },
    { path: '/login', element: h(LoginRoute) },
    { path: '/login/completing', element: h(ExternalAuthCompletionPage) },
  ], {
    initialEntries: ['/before', '/login?code=flow&state=state'],
    initialIndex: 1,
  })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await act(async () => root.render(h(RouterProvider, { router })))
    await settle(act)

    assert.equal(router.state.location.pathname, '/login/completing')
    assert.equal(router.state.location.search, '?code=flow&state=state')
    assert.match(container.textContent ?? '', /Finishing sign-in…/)
    assert.match(container.textContent ?? '', /Connecting to Nessie…/)
    assert.doesNotMatch(container.textContent ?? '', /Open the Nessie workspace/)
    assert.doesNotMatch(container.textContent ?? '', /Sign in with SSO/)

    await act(async () => { await router.navigate(-1) })
    await settle(act)
    assert.equal(router.state.location.pathname, '/before')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})
