import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import {
  KnowledgeSpaceResponseSchema,
  type KnowledgeSpaceResponse,
} from '@nessie/schemas'
import type { KnowledgePageRecord } from '../src/facades/knowledge/hooks.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/projects/00000000-0000-4000-8000-000000000002/docs',
})

const React = await import('react')
const { act, createElement: h, useEffect } = React
const { createRoot } = await import('react-dom/client')
const { MemoryRouter } = await import('react-router-dom')
const {
  KnowledgeProvider,
  useKnowledge,
} = await import('../src/components/features/knowledge/KnowledgeProvider.js')

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const listedSpaceId = '00000000-0000-4000-8000-000000000003'
const personalSpaceId = '00000000-0000-4000-8000-000000000004'
const personalPageId = '00000000-0000-4000-8000-000000000005'

const makeSpace = (input: {
  canWrite: boolean
  id: string
  metadata?: Record<string, unknown>
  name: string
}): KnowledgeSpaceResponse => KnowledgeSpaceResponseSchema.parse({
  canManageAccess: false,
  canWrite: input.canWrite,
  createdAt: '2026-08-31T12:00:00.000Z',
  createdBy: '00000000-0000-4000-8000-000000000006',
  deletedAt: null,
  description: null,
  id: input.id,
  memberAgentIds: [],
  memberUserIds: [],
  metadata: input.metadata ?? null,
  name: input.name,
  organizationId,
  ownerAgentId: null,
  policyChainTrace: ['decision:ALLOWED'],
  projectId,
  sensitivityTier: 'normal',
  sourceRef: `kb://first-party/spaces/${input.id}`,
  updatedAt: '2026-08-31T12:00:00.000Z',
  visibility: 'private',
  visibilityReason: 'private visibility',
  writeRestricted: false,
})

const listedSpace = makeSpace({
  canWrite: false,
  id: listedSpaceId,
  name: 'Project documents',
})
const personalSpace = makeSpace({
  canWrite: true,
  id: personalSpaceId,
  metadata: { personal: true },
  name: 'My Docs',
})

const Probe = () => {
  const {
    openPageDeepLink,
    selectedSpace,
    selectedSpaceId,
    spacesLoaded,
  } = useKnowledge()
  useEffect(() => {
    if (spacesLoaded && selectedSpaceId !== personalSpaceId) {
      openPageDeepLink({ pageId: personalPageId, spaceId: personalSpaceId })
    }
  }, [openPageDeepLink, selectedSpaceId, spacesLoaded])

  return h(
    'output',
    { 'data-testid': 'displayed-space' },
    selectedSpace ? `${selectedSpace.name}:${selectedSpace.canWrite ? 'writable' : 'read-only'}` : 'missing',
  )
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

test('a deep-linked space outside the scoped list uses its detail write verdict', async () => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  const calls: string[] = []
  const get: ApiClient['get'] = async <TData,>(path: string): Promise<TData> => {
    calls.push(path)
    if (path.startsWith('/api/knowledge-base/spaces?')) return [listedSpace] as TData
    if (path === `/api/knowledge-base/spaces/${personalSpaceId}`) return personalSpace as TData
    if (path.includes('/pages')) return [] as TData
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
              { initialEntries: [`/projects/${projectId}/docs`] },
              h(
                KnowledgeProvider,
                { projectId },
                h(Probe),
              ),
            ),
          ),
        ),
      )
    })

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (container.textContent === 'My Docs:writable') break
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }

    assert.equal(container.textContent, 'My Docs:writable')
    assert.ok(
      calls.includes(`/api/knowledge-base/spaces/${personalSpaceId}`),
      'the displayed space is fetched when the scoped list omits it',
    )
  } finally {
    await act(async () => { root.unmount() })
    queryClient.clear()
    container.remove()
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('switching spaces never paints the previous space’s pages while the next folder loads', async () => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  const alpha = makeSpace({ canWrite: true, id: listedSpaceId, name: 'Alpha documents' })
  const beta = makeSpace({ canWrite: true, id: personalSpaceId, name: 'Beta documents' })
  const oldPage = { id: personalPageId, parentPageId: null, position: 0, title: 'Old folder' } as KnowledgePageRecord
  let finishNextRead: ((pages: KnowledgePageRecord[]) => void) | undefined
  const nextRead = new Promise<KnowledgePageRecord[]>((resolve) => { finishNextRead = resolve })
  const get: ApiClient['get'] = async <TData,>(path: string): Promise<TData> => {
    if (path.startsWith('/api/knowledge-base/spaces?')) return [alpha, beta] as TData
    if (path === `/api/knowledge-base/spaces/${alpha.id}/pages`) return [oldPage] as TData
    if (path === `/api/knowledge-base/spaces/${beta.id}/pages`) return nextRead as Promise<TData>
    throw new Error(`Unexpected GET ${path}`)
  }
  const getPage: ApiClient['getPage'] = async <TData,>(path: string) => ({
    data: await get<TData>(path),
    meta: { hasMore: false, nextCursor: null, prevCursor: null, total: 2 },
  })
  const unavailable = async () => { throw new Error('Unexpected mutation') }
  const apiClient = { delete: unavailable, get, getPage, patch: unavailable,
    post: unavailable, put: unavailable } as ApiClient
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  let selectSpace: ((spaceId: string) => void) | undefined
  const SpaceProbe = () => {
    const knowledge = useKnowledge()
    selectSpace = knowledge.selectSpace
    return h('output', {}, JSON.stringify({
      loading: knowledge.pagesLoading,
      pages: knowledge.pages.map((page) => page.title),
      space: knowledge.selectedSpaceId,
    }))
  }

  try {
    await act(async () => {
      root.render(h(QueryClientProvider, { client: queryClient },
        h(ApiClientProvider, { client: apiClient },
          h(MemoryRouter, { initialEntries: [`/projects/${projectId}/docs`] },
            h(KnowledgeProvider, { projectId }, h(SpaceProbe))))))
    })
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (container.textContent?.includes('Old folder')) break
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    }
    assert.ok(container.textContent?.includes('Old folder'), 'first space has loaded')
    await act(async () => { selectSpace?.(beta.id) })
    assert.deepEqual(JSON.parse(container.textContent ?? '{}'), {
      loading: true,
      pages: [],
      space: beta.id,
    })
  } finally {
    await act(async () => { finishNextRead?.([]); root.unmount() })
    queryClient.clear()
    container.remove()
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
