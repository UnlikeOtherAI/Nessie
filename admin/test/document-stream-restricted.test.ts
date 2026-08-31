import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientError, type ApiClient } from '@nessie/client-core'
import type { DocumentStreamDetailResponse } from '@nessie/schemas'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/channels/channel-1',
})
const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { ApiClientProvider } = await import('@nessie/client-core')
const { useDocumentStreams } = await import('../src/facades/threads/document-stream.js')

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const threadId = '00000000-0000-4000-8000-000000000001'
const runId = '00000000-0000-4000-8000-000000000002'
const sessionId = '00000000-0000-4000-8000-000000000003'
const agentId = '00000000-0000-4000-8000-000000000004'
const markdown = '# Authorised document\n\nVisible to this reader.'
const detailPath = `/api/threads/${threadId}/document-streams/${sessionId}`

const detail: DocumentStreamDetailResponse = {
  lastSeq: 0,
  markdown,
  offset: markdown.length,
  session: {
    agentId,
    chars: markdown.length,
    errorReason: null,
    pageId: null,
    published: false,
    runId,
    sessionId,
    startedAt: '2026-08-31T12:00:00.000Z',
    status: 'streaming',
    target: {
      parentPageId: null,
      parentTitle: null,
      spaceId: null,
      spaceName: null,
    },
    title: 'Authorised document',
    versionNumber: null,
  },
}

const domGlobals = {
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.window.navigator,
  window: dom.window,
}

type DocumentStreamController = ReturnType<typeof useDocumentStreams>

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const withController = async (
  get: ApiClient['get'],
  run: (controller: () => DocumentStreamController, container: HTMLElement) => Promise<void>,
) => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  const unavailable = async () => {
    throw new Error('Unexpected mutation')
  }
  const apiClient = {
    delete: unavailable,
    get,
    patch: unavailable,
    post: unavailable,
    put: unavailable,
  } as unknown as ApiClient
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  let current: DocumentStreamController | null = null
  const Probe = () => {
    current = useDocumentStreams(threadId)
    return h('output', null, JSON.stringify(current.documentSessions))
  }
  const controller = () => {
    assert.ok(current)
    return current
  }

  try {
    await act(async () => {
      root.render(h(
        QueryClientProvider,
        { client: queryClient },
        h(ApiClientProvider, { client: apiClient }, h(Probe)),
      ))
    })
    await run(controller, container)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    queryClient.clear()
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('an entitled viewer hydrates a restricted frame from authorised detail', async () => {
  const calls: string[] = []
  const get: ApiClient['get'] = async <TData,>(path: string): Promise<TData> => {
    calls.push(path)
    assert.equal(path, detailPath)
    return detail as TData
  }

  await withController(get, async (controller, container) => {
    await act(async () => {
      controller().handleDocumentFrame('stream.document.start', {
        restricted: true,
        runId,
        sessionId,
      })
      await settle()
    })

    assert.deepEqual(calls, [detailPath])
    assert.equal(controller().documentSessions.length, 1)
    assert.equal(controller().documentStore.read(sessionId)?.markdown, markdown)
    assert.match(container.textContent ?? '', /Authorised document/)
  })
})

test('an unentitled viewer drops a restricted frame after detail returns 404', async () => {
  const calls: string[] = []
  const get: ApiClient['get'] = async <TData,>(path: string): Promise<TData> => {
    calls.push(path)
    throw new ApiClientError('Not found', 'NOT_FOUND', 404)
  }

  await withController(get, async (controller, container) => {
    await act(async () => {
      controller().handleDocumentFrame('stream.document.start', {
        restricted: true,
        runId,
        sessionId,
      })
      await settle()
    })

    assert.deepEqual(calls, [detailPath])
    assert.deepEqual(controller().documentSessions, [])
    assert.equal(controller().documentStore.read(sessionId), undefined)
    assert.equal(container.textContent, '[]')
  })
})
