import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'

import { openOverlayIn } from './support/overlay-host'

/**
 * Device-code sign-in for the two subscription providers that use it — ChatGPT
 * Codex and Grok.
 *
 * The dialog talks to the server on a lifecycle: start once, poll while the
 * person is signing in, abandon the parked credential on unmount. React Query
 * hands back a fresh mutation object on every render, so any of those effects
 * that keeps a mutation in its dependency array re-runs on every render — and
 * an abandon-on-unmount cleanup that re-runs is a cancel storm that fires on
 * its own start, then crashes the page with "maximum update depth exceeded".
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/settings/connections',
})

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { ApiClientProvider } = await import('@nessie/client-core')
const { createApiClient } = await import('../src/lib/api-client.js')
const { DeviceLinkDialog } = await import(
  '../src/pages/settings/connections/DeviceLinkDialog.js'
)

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const provider = {
  authStrategy: 'oauth_device' as const,
  displayName: 'ChatGPT Codex',
  key: 'openai_codex',
  models: [{ displayName: 'GPT-5 Codex', model: 'gpt-5-codex' }],
  termsNote: 'Your ChatGPT plan, your terms.',
}

const jsonResponse = (data: unknown): Response => new Response(
  JSON.stringify({ data }),
  { headers: { 'content-type': 'application/json' }, status: 200 },
)

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

const installDom = () => {
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
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

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const mount = async ({ pollStatuses = [] }: { pollStatuses?: unknown[] } = {}) => {
  const restoreDom = installDom()
  const previousFetch = globalThis.fetch
  const calls: string[] = []
  const remainingPolls = [...pollStatuses]

  globalThis.fetch = async (input, init) => {
    const path = typeof input === 'string' ? input : (input as Request).url
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (path === '/api/model-subscriptions/device/start') {
      return jsonResponse({
        expiresAt: '2026-09-05T12:15:00.000Z',
        // The dialog floors this at 2s, whatever the provider asks for.
        intervalMs: 10,
        stateToken: 'state-token-1',
        userCode: 'HJKL-9021',
        verificationUri: 'https://auth.openai.com/device',
      })
    }
    if (path === '/api/model-subscriptions/device/poll') {
      return jsonResponse(remainingPolls.shift() ?? { intervalMs: 5_000, status: 'pending' })
    }
    if (path === '/api/model-subscriptions/device/confirm') {
      return jsonResponse({ subscriptionId: 'sub-1' })
    }
    if (path === '/api/model-subscriptions/device/cancel') return jsonResponse({ ok: true })
    return new Response('unexpected request', { status: 500 })
  }

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
          ApiClientProvider,
          { client: createApiClient(null) },
          h(DeviceLinkDialog, { onClose: () => undefined, provider }),
        ),
      ),
    )
  })
  await settle()

  const overlay = () => openOverlayIn(dom.window.document)

  return {
    calls,
    click: async (label: string) => {
      const button = [...overlay().querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === label,
      )
      assert.ok(button, `no "${label}" button in the dialog`)
      await act(async () => {
        button.dispatchEvent(
          new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
        )
      })
      await settle()
    },
    countOf: (call: string) => calls.filter((entry) => entry === call).length,
    dispose: async () => {
      await act(async () => root.unmount())
      container.remove()
      globalThis.fetch = previousFetch
      restoreDom()
    },
    text: () => overlay().textContent ?? '',
    // The dialog's own floor on how often it asks the server is 2s, so a real
    // wait is the only honest way to watch a poll happen.
    waitForPoll: async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2_200))
      })
      await settle()
    },
  }
}

test('the sign-in code is shown, and the flow is not cancelled while the dialog is open', async () => {
  const view = await mount()
  try {
    assert.match(view.text(), /HJKL-9021/)
    assert.equal(view.countOf('POST /api/model-subscriptions/device/start'), 1)
    // The abandon-on-unmount cleanup must not run while the dialog is open:
    // cancelling here tombstones the credential the person is still signing in
    // for, and re-running it every render is the crash.
    assert.equal(view.countOf('POST /api/model-subscriptions/device/cancel'), 0)
  } finally {
    await view.dispose()
  }
})

test('abandoning the dialog cancels the parked flow exactly once', async () => {
  const view = await mount()
  await view.dispose()
  assert.equal(view.countOf('POST /api/model-subscriptions/device/cancel'), 1)
})

test('polling carries the flow to the confirmation step, which links without cancelling', async () => {
  const view = await mount({
    pollStatuses: [{
      accountId: 'acct_9f2',
      accountLabel: 'ondrej@example.test',
      status: 'awaiting_confirmation',
    }],
  })
  try {
    await view.waitForPoll()
    assert.equal(view.countOf('POST /api/model-subscriptions/device/poll'), 1)
    // The account that arrived is named before anything is attached: the
    // defence against somebody else's account riding in on this code.
    assert.match(view.text(), /Signed in as/)
    assert.match(view.text(), /ondrej@example\.test/)

    await view.click('Yes, connect it')
    assert.equal(view.countOf('POST /api/model-subscriptions/device/confirm'), 1)
  } finally {
    await view.dispose()
  }
  // A confirmed link is not an abandoned one.
  assert.equal(view.countOf('POST /api/model-subscriptions/device/cancel'), 0)
})
