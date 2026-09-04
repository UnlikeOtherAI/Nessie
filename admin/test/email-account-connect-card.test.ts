import assert from 'node:assert/strict'
import test from 'node:test'

import type { ApiClient } from '@nessie/client-core'
import { JSDOM } from 'jsdom'

import { stubResizeObserver } from './support/resize-observer-stub'
import {
  EmailAccountConnectCard,
  hasEmailAccountConnectCard,
  readEmailAccountConnectScope,
} from '../src/components/features/channels/EmailAccountConnectCard.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/channels',
})
stubResizeObserver(dom.window as unknown as Window & typeof globalThis)

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { ApiClientProvider } = await import('@nessie/client-core')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const installDom = () => {
  const values = {
    document: dom.window.document,
    Element: dom.window.Element,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
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

test('only the dedicated email-account connect card opens the secure form', () => {
  assert.equal(
    hasEmailAccountConnectCard({ card: { kind: 'email_account_connect' } }),
    true,
  )
  assert.equal(hasEmailAccountConnectCard({ card: { kind: 'comms_connect' } }), false)
  assert.equal(hasEmailAccountConnectCard({ card: 'email_account_connect' }), false)
  assert.equal(hasEmailAccountConnectCard(undefined), false)
})

test('the card defaults to personal scope and preserves an explicit team scope', () => {
  assert.equal(
    readEmailAccountConnectScope({ card: { kind: 'email_account_connect' } }),
    'user',
  )
  assert.equal(
    readEmailAccountConnectScope({
      card: { kind: 'email_account_connect', scope: 'team' },
    }),
    'team',
  )
  assert.equal(readEmailAccountConnectScope({ card: { kind: 'other' } }), null)
})

test('the chat doorway opens the reused address-first modal without a password field', async () => {
  const restoreDom = installDom()
  const host = dom.window.document.createElement('div')
  dom.window.document.body.append(host)
  const root = createRoot(host)
  const unavailable = async () => { throw new Error('unexpected API call') }
  const apiClient = {
    delete: unavailable,
    get: async <TData>(path: string): Promise<TData> => {
      if (path === '/api/teams') return [] as TData
      throw new Error(`unexpected GET ${path}`)
    },
    getPage: unavailable,
    patch: unavailable,
    post: unavailable,
    put: unavailable,
  } as ApiClient

  try {
    await act(async () => {
      root.render(h(
        QueryClientProvider,
        { client: new QueryClient() },
        h(
          ApiClientProvider,
          { client: apiClient },
          h(EmailAccountConnectCard, {
            metadata: { card: { kind: 'email_account_connect', scope: 'user' } },
          }),
        ),
      ))
    })
    const opener = [...host.querySelectorAll('button')].find((button) =>
      button.textContent === 'Connect email',
    )
    assert.ok(opener)
    await act(async () => {
      opener.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })

    const modal = dom.window.document.body
    assert.match(modal.textContent ?? '', /Connect email/)
    const emailField = modal.querySelector('input[placeholder="name@company.com"]')
    assert.equal(emailField?.getAttribute('type'), 'email')
    for (const provider of ['Google', 'Microsoft', 'iCloud', 'Other provider']) {
      assert.match(modal.textContent ?? '', new RegExp(provider))
    }
    assert.equal(modal.querySelector('input[type="password"]'), null)
  } finally {
    await act(async () => root.unmount())
    host.remove()
    dom.window.document.querySelector('.admin-overlay-root')?.remove()
    restoreDom()
  }
})
