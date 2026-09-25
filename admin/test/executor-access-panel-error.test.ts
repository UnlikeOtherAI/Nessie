import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { JSDOM } from 'jsdom'
import * as ReactNamespace from 'react'

import type { ExecutorRecordResponse } from '@nessie/schemas'
import type { ExecutorAccessViewWithLocalMcp } from '../src/facades/executors/local-mcp.js'
import { executorKeys } from '../src/facades/executors/keys.js'

/**
 * What the screen says when it cannot read the access view.
 *
 * Taking the access *data* rather than the query, this panel rendered a failed
 * fetch as a finding: "private=unknown, project=none, organization=none", with
 * every management form absent because `canManage` reads `false` on
 * `undefined`. An organisation owner, looking at an executor they administer,
 * was told in effect that they administer nothing — and given no way to tell
 * that from a genuine lack of standing.
 *
 * So both directions are asserted here: the refusal must be visible and name
 * its remedy, and the working case must still put the grant controls on screen.
 */

;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/agents/executors',
})

const domGlobals = {
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  document: dom.window.document,
  Element: dom.window.Element,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  localStorage: dom.window.localStorage,
  MouseEvent: dom.window.MouseEvent,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  window: dom.window,
}

/**
 * The admin suite runs `--experimental-test-isolation=none`, so every file
 * shares one process and one `globalThis`. Installing this DOM permanently
 * would hand our `localStorage` and `window` to whichever file runs next —
 * which is not a hypothetical: doing exactly that broke three unrelated
 * auth-session tests that persist a logout marker. So the DOM is installed
 * for the duration of a render and put back afterwards.
 */
const withDom = async <T>(body: () => Promise<T>): Promise<T> => {
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  try {
    return await body()
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
}

after(() => { dom.window.close() })

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { MemoryRouter } = await import('react-router-dom')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { ApiClientError, ApiClientProvider, createApiClient } = await import('@nessie/client-core')
const { ExecutorDetailPanels } = await import(
  '../src/components/features/executors/ExecutorDetailPanels.js'
)

const executor = {
  id: '6ee804f6-d7a9-4eb6-b357-60c81e21e8e0',
  label: 'MINIS - Ondra Windows',
  scope: { kind: 'private' },
  status: 'online',
} as unknown as ExecutorRecordResponse

const accessView = {
  canManage: true,
  descriptorRevisions: [],
  effectiveAccess: { organizationRole: 'owner', privateAssignment: 'admin', projectRole: null },
  executorId: executor.id,
  operationGrants: [],
  privateAssignments: [],
  sessions: [],
} as unknown as ExecutorAccessViewWithLocalMcp

/** The rendered markup, with the DOM taken back down before we assert on it. */
const render = (accessQuery: unknown): Promise<string> => withDom(async () => {
  const container = dom.window.document.createElement('div')
  dom.window.document.body.append(container)
  const root = createRoot(container)
  const client = createApiClient({ baseUrl: 'https://api.example.test', token: () => 'token' })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(executorKeys.sharing(executor.id, 'team'), {
    executorId: executor.id, teamId: 'team', ownerUserId: 'owner', everyone: false,
    people: [{ userId: 'owner', name: 'Owner', role: 'admin' }],
    projects: [], availablePeople: [], availableProjects: [],
  })
  queryClient.setQueryDefaults(executorKeys.sharing(executor.id, 'team'), { staleTime: Infinity })
  await act(async () => {
    root.render(h(
      QueryClientProvider,
      { client: queryClient },
      h(
        ApiClientProvider,
        { client },
        h(
          MemoryRouter,
          { initialEntries: ['/agents/executors?tab=permissions'] },
          h(ExecutorDetailPanels, {
            accessQuery: accessQuery as never,
            executor,
            teamId: 'team',
            onPrepared: () => {},
          }),
        ),
      ),
    ))
  })
  await act(async () => { await Promise.resolve() })
  const text = container.textContent ?? ''
  const buttons = [...container.querySelectorAll('button')].map((button) => button.textContent)
  const selects = container.querySelectorAll('select').length
  await act(async () => { root.unmount() })
  container.remove()
  return JSON.stringify({ buttons, selects, text })
})

const rendered = async (accessQuery: unknown) => JSON.parse(await render(accessQuery)) as {
  buttons: Array<string | null>
  selects: number
  text: string
}

const erroredQuery = (error: unknown) => ({
  data: undefined,
  error,
  isError: true,
  isLoading: false,
  refetch: () => {},
})

test('a payload this build cannot read is said out loud, not rendered as a lack of standing', async () => {
  const { text } = await rendered(erroredQuery(new ApiClientError('bad', 'INVALID_RESPONSE', 200)))

  assert.match(text, /older than the server/, 'the sentence must name the stale app')
  assert.match(text, /Update or reinstall/, 'and the remedy Retry cannot reach')
  // The lie the panel used to tell.
  assert.doesNotMatch(text, /private=unknown/)
  // The tabs still work: a failed fetch must not throw away the place the
  // person had navigated to. Naming the executor is the screen header's job on
  // `/agents/executors/:executorId`, not this panel's — it used to repeat the
  // label and status inside its own card, one heading below the screen's.
  assert.match(text, /Permissions/)
})

test('an ordinary failure keeps the ordinary sentence and the Retry', async () => {
  const { buttons, text } = await rendered(erroredQuery(new Error('network down')))
  assert.match(text, /could not be loaded/)
  assert.doesNotMatch(text, /older than the server/)
  assert.ok(buttons.includes('Retry'), 'a failed fetch offers the one recovery it has')
})

test('when the access view reads, the grant controls are on screen', async () => {
  const { selects, text } = await rendered({
    data: accessView,
    error: null,
    isError: false,
    isLoading: false,
    refetch: () => {},
  })
  assert.match(text, /Everyone in this team can use this executor/)
  assert.match(text, /Can useAdmin/)
  assert.match(text, /Projects/)
  assert.doesNotMatch(text, /Review changes|Review activation/)
  assert.doesNotMatch(text, /could not be loaded/)
  assert.equal(selects, 3, 'person, access role and project are editable directly')
})
