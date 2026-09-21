import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { JSDOM } from 'jsdom'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

import { LocalInferenceHostStatus } from '../src/components/features/local-inference/LocalInferenceHostStatus.js'
import type { LocalInferenceHost } from '../src/facades/local-inference/hooks.js'
import { localInferenceKeys } from '../src/facades/local-inference/keys.js'
import { openOverlayIn } from './support/overlay-host.js'

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
  assert.match(html, /Disconnect local models/)
  assert.doesNotMatch(html, /Offline — start Nessie Desktop/)
  assert.doesNotMatch(html, /Open executor/)
})

test('Connections keeps the doorway into the same scoped executor surface', () => {
  const html = render()

  assert.match(html, /Open executor/)
  assert.match(html, /href="\/agents\/executors\/executor-a"/)
})

// The status surface has two doorways, but one destructive action. Exercise it
// through the actual shared dialog rather than merely asserting its JSX shape.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/settings/connections',
})
const ReactClient = await import('react')
const { act, createElement: h } = ReactClient
const { createRoot } = await import('react-dom/client')

const domGlobals = {
  document: dom.window.document,
  Element: dom.window.Element,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  navigator: dom.window.navigator,
  window: dom.window,
}

const mountHostStatus = async () => {
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  const calls: Array<{ body: unknown; path: string }> = []
  const client = {
    delete: unavailable,
    get: async () => ({ hosts: [host({})], meta: { total: 1 } }),
    patch: unavailable,
    post: async (path: string, body: unknown) => { calls.push({ body, path }) },
    put: unavailable,
  } as ApiClient
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(localInferenceKeys.hosts, { hosts: [host({})], meta: { total: 1 } })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(
      h(
        QueryClientProvider,
        { client: queryClient },
        h(
          ApiClientProvider,
          { client },
          h(MemoryRouter, null, h(LocalInferenceHostStatus, { empty: h('p', null, 'No local Ollama host.') })),
        ),
      ),
    )
  })

  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
  }
  const revoke = () => {
    const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Disconnect local models')
    assert.ok(button, 'the host has a revoke action')
    return button
  }
  const dialogButton = (testId: string) => {
    const button = openOverlayIn(dom.window.document).querySelector(`[data-testid="${testId}"]`)
    assert.ok(button instanceof dom.window.HTMLButtonElement, `the ${testId} control opened`)
    return button
  }

  return {
    calls,
    click,
    dialogText: () => openOverlayIn(dom.window.document).textContent ?? '',
    revoke,
    close: async () => {
      await act(async () => { root.unmount() })
      container.remove()
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
    confirm: () => dialogButton('confirm-dialog-confirm'),
    cancel: () => dialogButton('confirm-dialog-cancel'),
  }
}

test('revocation remains a shared repair but only reaches the server after explicit confirmation', async () => {
  const view = await mountHostStatus()
  try {
    await view.click(view.revoke())
    assert.match(view.dialogText(), /Disconnect local models\?/)
    assert.match(view.dialogText(), /Agents will stop using this computer’s local models/)
    assert.match(
      view.dialogText(),
      /executor pairing and other machine permissions stay connected/,
    )
    assert.equal(view.calls.length, 0, 'opening the destructive confirmation must not revoke')

    await view.click(view.cancel())
    assert.equal(view.calls.length, 0, 'cancelling keeps the connection intact')
  } finally {
    await view.close()
  }

  const confirmed = await mountHostStatus()
  try {
    await confirmed.click(confirmed.revoke())
    await confirmed.click(confirmed.confirm())
    assert.deepEqual(confirmed.calls, [{ body: {}, path: '/api/local-inference/hosts/host-a/revoke' }])
  } finally {
    await confirmed.close()
  }
})

test('the native discovery control says it will look for Ollama, not prepare a vague computer state', () => {
  const source = readFileSync(
    new URL('../src/pages/settings/connections/LocalOllamaSection.tsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /Find Ollama on this computer/)
  assert.match(source, /Looking for Ollama…/)
  assert.doesNotMatch(source, /Prepare this computer|Preparing this computer…/)
})
