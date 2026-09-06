import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import {
  KnowledgeSpaceResponseSchema,
  type KnowledgeSpaceResponse,
} from '@nessie/schemas'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { JSDOM } from 'jsdom'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const spaceId = '00000000-0000-4000-8000-000000000003'
const pageId = '00000000-0000-4000-8000-000000000004'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: `http://localhost:5455/projects/${projectId}/docs?pageId=${pageId}`,
})

const React = await import('react')
const { act, createElement: h, useState } = React
const { createRoot } = await import('react-dom/client')
const { MemoryRouter } = await import('react-router-dom')
const {
  KnowledgeProvider,
  useKnowledge,
} = await import('../src/components/features/knowledge/KnowledgeProvider.js')
const {
  useKnowledgePageDeepLink,
} = await import('../src/components/features/knowledge/useKnowledgePageDeepLink.js')

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const space: KnowledgeSpaceResponse = KnowledgeSpaceResponseSchema.parse({
  canManageAccess: false,
  canWrite: true,
  createdAt: '2026-09-01T12:00:00.000Z',
  createdBy: '00000000-0000-4000-8000-000000000005',
  deletedAt: null,
  description: null,
  id: spaceId,
  memberAgentIds: [],
  memberUserIds: [],
  metadata: null,
  name: 'Project documents',
  organizationId,
  ownerAgentId: null,
  policyChainTrace: ['decision:ALLOWED'],
  projectId,
  sensitivityTier: 'normal',
  sourceRef: `kb://first-party/spaces/${spaceId}`,
  updatedAt: '2026-09-01T12:00:00.000Z',
  visibility: 'private',
  visibilityReason: 'private visibility',
  writeRestricted: false,
})

const page = {
  childPageIds: [],
  createdAt: '2026-09-01T12:00:00.000Z',
  id: pageId,
  kind: 'document',
  labels: [],
  latestVersion: null,
  metadata: null,
  parentPageId: null,
  policyChainTrace: ['decision:ALLOWED'],
  position: 0,
  publishedVersion: null,
  publishedVersionId: null,
  sourceRef: `kb://first-party/pages/${pageId}`,
  spaceId,
  status: 'draft',
  summary: null,
  title: 'Linked document',
  updatedAt: '2026-09-01T12:00:00.000Z',
  visibilityReason: 'space visibility',
}

// The `?pageId=` link with no `spaceId`: the owning space is resolved from the
// page record first, which is the branch that used to re-POST without bound.
const openers = new Set<unknown>()

const Probe = ({ tick }: { tick: number }) => {
  const { openPageDeepLink, openPageId } = useKnowledge()
  useKnowledgePageDeepLink()
  openers.add(openPageDeepLink)
  return h('output', { 'data-testid': 'deep-link', 'data-tick': tick }, openPageId ?? 'none')
}

let forceRerender: ((value: number) => void) | null = null

// A parent whose state moves — the ordinary cause of a provider re-render.
// Nothing here remounts, so a second consume of the link would be a defect.
const Harness = () => {
  const [tick, setTick] = useState(0)
  forceRerender = setTick
  return h(KnowledgeProvider, { projectId }, h(Probe, { tick }))
}

const domGlobals = {
  CustomEvent: dom.window.CustomEvent,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.window.navigator,
  window: dom.window,
}

test('a ?pageId= deep link resolves and opens exactly once across re-renders', async () => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  let lookups = 0
  const get: ApiClient['get'] = async <TData,>(path: string): Promise<TData> => {
    if (path.startsWith('/api/knowledge-base/spaces?')) return [space] as TData
    if (path === `/api/knowledge-base/spaces/${spaceId}`) return space as TData
    if (path === `/api/knowledge-base/spaces/${spaceId}/pages`) return [page] as TData
    if (path === `/api/knowledge-base/pages/${pageId}`) {
      lookups += 1
      return page as TData
    }
    throw new Error(`Unexpected GET ${path}`)
  }
  const getPage: ApiClient['getPage'] = async <TData,>(path: string) => ({
    data: await get<TData>(path),
    meta: { hasMore: false, nextCursor: null, prevCursor: null, total: 1 },
  })
  const unavailable = async () => { throw new Error('Unexpected mutation') }
  const apiClient = {
    delete: unavailable,
    get,
    getPage,
    patch: unavailable,
    post: unavailable,
    put: unavailable,
  } as ApiClient
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  const settle = async (times: number): Promise<void> => {
    for (let attempt = 0; attempt < times; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }

  try {
    await act(async () => {
      root.render(
        h(
          QueryClientProvider,
          { client: queryClient },
          h(
            ApiClientProvider,
            { client: apiClient },
            h(
              MemoryRouter,
              { initialEntries: [`/projects/${projectId}/docs?pageId=${pageId}`] },
              h(Harness),
            ),
          ),
        ),
      )
    })

    await settle(20)
    assert.equal(container.textContent, pageId, 'the linked document opens')
    assert.equal(lookups, 1, 'the page lookup runs once for one link')

    // Re-render the provider's subtree the way any parent state change would.
    // Before the value was memoized this re-created `openPageDeepLink`, which
    // re-armed the deep-link effect and re-issued the lookup on every pass.
    for (let tick = 1; tick <= 5; tick += 1) {
      await act(async () => { forceRerender?.(tick) })
      await settle(3)
    }

    assert.equal(lookups, 1, 'a re-render must not re-issue the deep-link lookup')
    assert.equal(container.textContent, pageId, 'the linked document stays open')
    assert.equal(openers.size, 1, 'openPageDeepLink keeps one identity for the mount')
  } finally {
    await act(async () => { root.unmount() })
    queryClient.clear()
    container.remove()
    forceRerender = null
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
