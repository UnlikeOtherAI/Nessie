import assert from 'node:assert/strict'
import test from 'node:test'

import type { ApiClient } from '@nessie/client-core'
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

const domGlobals = {
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.window.navigator,
  window: dom.window,
}

test('a restricted structural frame leaves no session for the popup or chip', async () => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  const neverFetch = async () => {
    throw new Error('a restricted start must not bootstrap')
  }
  const apiClient = {
    delete: neverFetch,
    get: neverFetch,
    patch: neverFetch,
    post: neverFetch,
    put: neverFetch,
  } as unknown as ApiClient
  const queryClient = new QueryClient()
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  let controller: ReturnType<typeof useDocumentStreams> | null = null
  const Probe = () => {
    controller = useDocumentStreams('thread-1')
    return h('output', null, JSON.stringify(controller.documentSessions))
  }

  try {
    await act(async () => {
      root.render(h(
        QueryClientProvider,
        { client: queryClient },
        h(ApiClientProvider, { client: apiClient }, h(Probe)),
      ))
    })
    await act(async () => {
      controller!.handleDocumentFrame('stream.document.start', {
        restricted: true,
        runId: 'run-1',
        sessionId: 'session-1',
      })
    })
    assert.deepEqual(controller!.documentSessions, [])

    await act(async () => {
      controller!.handleDocumentFrame('stream.document.start', {
        runId: 'run-2',
        sessionId: 'session-2',
      })
      controller!.handleDocumentFrame('stream.document.meta', {
        sessionId: 'session-2',
        title: 'Secret title',
      })
    })
    assert.equal(controller!.documentSessions[0]?.title, 'Secret title')

    await act(async () => {
      controller!.handleDocumentFrame('stream.document.error', {
        reason: 'run_failed',
        restricted: true,
        sessionId: 'session-2',
      })
    })
    assert.deepEqual(controller!.documentSessions, [])
    assert.equal(container.textContent, '[]')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    queryClient.clear()
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
