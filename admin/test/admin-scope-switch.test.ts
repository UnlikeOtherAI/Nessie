import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import { stubResizeObserver } from './support/resize-observer-stub'

// The scope switch mounted over a memory router, the way the AI models page
// uses it: the landing team written into the address with a replace, a team
// the address names but the page does not offer shown as an error rather
// than swapped for another scope, and a scope change carrying the page's own
// filters while dropping the list page that belonged to the old scope.

const DESIGN = { id: '11111111-1111-4111-8111-111111111111', name: 'Design', viewerIsMember: true }
const SALES = { id: '22222222-2222-4222-8222-222222222222', name: 'Sales', viewerIsMember: true }

const withDom = async (run: (dom: JSDOM) => Promise<void>): Promise<void> => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'https://app.example/',
  })
  stubResizeObserver(dom.window as unknown as Window & typeof globalThis)
  const values = {
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: dom.window.navigator,
    ResizeObserver: dom.window.ResizeObserver,
    window: dom.window,
  }
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  try {
    await run(dom)
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    dom.window.close()
  }
}

const settle = async (act: (callback: () => Promise<void>) => Promise<void>): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

type Viewer = { isOrganizationAdmin: boolean; isOwner: boolean }

const mount = async (dom: JSDOM, viewer: Viewer, entry: string) => {
  const React = await import('react')
  const { act, createElement: h } = React
  const { createRoot } = await import('react-dom/client')
  const { createMemoryRouter, RouterProvider } = await import('react-router-dom')
  const { useAdminScope } = await import('../src/components/features/settings/useAdminScope')
  const { useTrackLocationKey } = await import('../src/navigation/redirect')
  const { modelScopeOptions } = await import('../src/pages/admin/scope-entitlements')
  ;(globalThis as typeof globalThis & { React: typeof React }).React = React

  const options = modelScopeOptions(viewer, [DESIGN, SALES])
  const Probe = () => {
    useTrackLocationKey()
    const { resolution, strip } = useAdminScope({
      ariaLabel: 'Whose AI models',
      clears: ['cursor', 'direction', 'page'],
      options,
      preferredTeamId: SALES.id,
    })
    return h('div', null, strip, h('p', { 'data-testid': 'status' }, resolution.status))
  }
  const router = createMemoryRouter([{ element: h(Probe), path: '/admin/models' }], {
    initialEntries: [entry],
  })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(h(RouterProvider, { router })))
  await settle(act)

  return {
    act,
    radios: () => [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')],
    router,
    scope: () => new URLSearchParams(router.state.location.search).get('scope'),
    settle: () => settle(act),
    status: () => container.querySelector('[data-testid="status"]')?.textContent,
    unmount: () => act(async () => root.unmount()),
  }
}

test('an admin lands on a team, written into the address, with the organisation disabled and why', async () => {
  await withDom(async (dom) => {
    const view = await mount(
      dom,
      { isOrganizationAdmin: true, isOwner: false },
      '/admin/models?model=gpt&cursor=abc&page=2',
    )
    try {
      // The landing is the working team, and the address now names it — a
      // replace, so Back leaves the page rather than returning to a bare one.
      assert.equal(view.scope(), `team:${SALES.id}`)
      assert.equal(view.router.state.historyAction, 'REPLACE')
      assert.equal(view.status(), 'ready')
      // The page's filter stays; a list page that belonged to no team goes.
      const params = new URLSearchParams(view.router.state.location.search)
      assert.equal(params.get('model'), 'gpt')
      assert.equal(params.get('cursor'), null)
      assert.equal(params.get('page'), null)

      const [organisation, design, sales] = view.radios()
      assert.equal(organisation?.textContent, 'Organisation')
      assert.equal(organisation?.disabled, true)
      assert.match(organisation?.title ?? '', /Only the organisation owner/)
      assert.equal(design?.disabled, false)
      assert.equal(sales?.getAttribute('aria-checked'), 'true')
    } finally {
      await view.unmount()
    }
  })
})

test('a team the page does not offer is an error on screen, and the address is left alone', async () => {
  await withDom(async (dom) => {
    const foreign = 'team:33333333-3333-4333-8333-333333333333'
    const view = await mount(dom, { isOrganizationAdmin: true, isOwner: true }, `/admin/models?scope=${foreign}`)
    try {
      assert.equal(view.status(), 'unknown')
      assert.equal(view.scope(), foreign)
      // Nothing is shown as selected: the organisation is not quietly standing in.
      assert.equal(view.radios().some((radio) => radio.getAttribute('aria-checked') === 'true'), false)
    } finally {
      await view.unmount()
    }
  })
})

test('changing scope keeps the page’s filters and drops the old scope’s list page', async () => {
  await withDom(async (dom) => {
    const view = await mount(
      dom,
      { isOrganizationAdmin: true, isOwner: true },
      '/admin/models?model=gpt&cursor=abc&direction=forward&page=2',
    )
    try {
      // The owner's address names no scope: the organisation, left unspelled.
      assert.equal(view.status(), 'ready')
      assert.equal(view.scope(), null)
      assert.equal(view.radios()[0]?.getAttribute('aria-checked'), 'true')

      const design = view.radios()[1]
      assert.ok(design)
      await view.act(async () => design.click())
      await view.settle()

      const params = new URLSearchParams(view.router.state.location.search)
      assert.equal(params.get('scope'), `team:${DESIGN.id}`)
      assert.equal(params.get('model'), 'gpt')
      assert.equal(params.get('cursor'), null)
      assert.equal(params.get('page'), null)
      assert.equal(view.router.state.historyAction, 'REPLACE')

      // Back to the organisation: the address stops naming a scope at all.
      const organisation = view.radios()[0]
      assert.ok(organisation)
      await view.act(async () => organisation.click())
      await view.settle()
      assert.equal(view.scope(), null)
    } finally {
      await view.unmount()
    }
  })
})
