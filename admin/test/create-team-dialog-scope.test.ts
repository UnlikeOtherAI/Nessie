import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'

import { stubResizeObserver } from './support/resize-observer-stub'

/**
 * The rail's doorway says "Add team". The dialog behind it opened on the
 * *organisation* tab, titled "Create an organisation", so the door and the room
 * disagreed and founding a whole organisation was one accidental Enter away
 * (2026-09-13 invitation e2e run, F7).
 *
 * Asserted through the rendered dialog rather than the source, because the
 * title is derived from the same state the tab strip and the submit button
 * read: a default that changed in one of those places and not the others is
 * exactly the regression worth catching.
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/channels',
})
stubResizeObserver(dom.window as unknown as Window & typeof globalThis)

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { MemoryRouter } = await import('react-router-dom')
const { ApiClientProvider } = await import('../src/providers/ApiClientProvider.js')
const { AuthSessionProvider } = await import('../src/providers/AuthSessionProvider.js')
const { CreateTeamDialog } = await import('../src/layouts/admin-shell/CreateTeamDialog.js')

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const installDom = () => {
  const values = {
    document: dom.window.document,
    Element: dom.window.Element,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
    MouseEvent: dom.window.MouseEvent,
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

const unauthenticated = (async () =>
  new Response('{}', { headers: { 'content-type': 'application/json' }, status: 401 })) as typeof fetch

const openDialog = async (canCreateTeam: boolean) => {
  const restoreDom = installDom()
  const previousFetch = globalThis.fetch
  globalThis.fetch = unauthenticated
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

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
            h(
              MemoryRouter,
              { initialEntries: ['/channels'] },
              h(CreateTeamDialog, {
                canCreateTeam,
                onClose: () => undefined,
                open: true,
                organizationName: 'Alpha Team',
              }),
            ),
          ),
        ),
      ),
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  // Overlays portal out of the tree they were declared in, so the dialog is
  // read from the document rather than from `container`.
  return {
    body: dom.window.document.body,
    close: async () => {
      await act(async () => root.unmount())
      container.remove()
      queryClient.clear()
      dom.window.localStorage.clear()
      globalThis.fetch = previousFetch
      restoreDom()
    },
  }
}

const tabLabels = (body: HTMLElement): string[] =>
  [...body.querySelectorAll('[role="radiogroup"] button')].map(
    (tab) => tab.textContent?.trim() ?? '',
  )

const selectedTab = (body: HTMLElement): string | undefined =>
  [...body.querySelectorAll('[role="radiogroup"] button')]
    .find((tab) => tab.getAttribute('aria-checked') === 'true')
    ?.textContent?.trim()

test('"Add team" opens on the team tab, titled "Create a team"', async () => {
  const { body, close } = await openDialog(true)
  try {
    const heading = body.querySelector('h2')?.textContent?.trim()
    assert.equal(heading, 'Create a team')
    assert.equal(selectedTab(body), 'In Alpha Team')
    // The organisation flow stays one click away, with its own copy intact.
    assert.deepEqual(tabLabels(body), ['In Alpha Team', 'New organisation'])
    assert.match(body.textContent ?? '', /Adds a team to your current organisation and opens it\./)
    const submit = [...body.querySelectorAll('button')].find(
      (button) => button.getAttribute('type') === 'submit',
    )
    assert.equal(submit?.textContent?.trim(), 'Create team')
  } finally {
    await close()
  }
})

test('the organisation flow keeps its copy when the tab is chosen', async () => {
  const { body, close } = await openDialog(true)
  try {
    const organisationTab = [...body.querySelectorAll('[role="radiogroup"] button')].find(
      (tab) => tab.textContent?.trim() === 'New organisation',
    ) as HTMLButtonElement | undefined
    assert.ok(organisationTab)
    await act(async () => organisationTab.click())

    assert.equal(body.querySelector('h2')?.textContent?.trim(), 'Create an organisation')
    assert.match(
      body.textContent ?? '',
      /Creates the organisation in UnlikeOtherAI with you as its owner, and opens its first team\./,
    )
  } finally {
    await close()
  }
})

test('a member who cannot create a team here is still offered an organisation, and told so', async () => {
  const { body, close } = await openDialog(false)
  try {
    assert.equal(body.querySelector('h2')?.textContent?.trim(), 'Create an organisation')
    // A strip with one option is a label pretending to be a choice.
    assert.equal(body.querySelector('[role="radiogroup"]'), null)
    assert.match(
      body.textContent ?? '',
      /Creates the organisation in UnlikeOtherAI with you as its owner, and opens its first team\./,
    )
  } finally {
    await close()
  }
})
