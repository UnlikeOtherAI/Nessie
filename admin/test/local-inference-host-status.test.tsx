import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

import { LocalInferenceHostStatus } from '../src/components/features/local-inference/LocalInferenceHostStatus.js'
import type { LocalInferenceHost } from '../src/facades/local-inference/hooks.js'
import { localInferenceKeys } from '../src/facades/local-inference/keys.js'

/**
 * Connections and Executor detail must be two doorways to one status surface.
 * In particular, opening a paired executor must not leave the person with an
 * unscoped Connections-only control, nor accidentally show another computer.
 */

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const unavailable = async (): Promise<never> => { throw new Error('unexpected API call') }
const apiClient = {
  delete: unavailable,
  get: unavailable,
  patch: unavailable,
  post: unavailable,
  put: unavailable,
} as ApiClient

const host = (overrides: Partial<LocalInferenceHost>): LocalInferenceHost => ({
  availability: 'online',
  executorId: 'executor-a',
  id: 'host-a',
  lastSeenAt: '2026-09-20T10:00:00.000Z',
  models: [{ manifestDigest: 'a'.repeat(64), name: 'qwen3:8b' }],
  paused: false,
  status: 'active',
  transport: 'executor',
  ...overrides,
})

const render = (executorId?: string): string => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(localInferenceKeys.hosts, {
    hosts: [
      host({}),
      host({
        availability: 'offline',
        executorId: 'executor-b',
        id: 'host-b',
        models: [],
      }),
    ],
    meta: { total: 2 },
  })

  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/agents/executors/executor-a'] },
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          ApiClientProvider,
          { client: apiClient },
          createElement(LocalInferenceHostStatus, {
            empty: createElement('p', null, 'No local Ollama host.'),
            ...(executorId ? { executorId } : {}),
          }),
        ),
      ),
    ),
  )
}

test('an executor detail gets its own host status and real repairs', () => {
  const html = render('executor-a')

  assert.match(html, /Online — ready for a selected local model\./)
  assert.match(html, /Pause/)
  assert.match(html, /Revoke/)
  assert.doesNotMatch(html, /Offline — start Nessie Desktop/)
  assert.doesNotMatch(html, /Open executor/)
})

test('Connections keeps the doorway into the same scoped executor surface', () => {
  const html = render()

  assert.match(html, /Open executor/)
  assert.match(html, /href="\/agents\/executors\/executor-a"/)
})
