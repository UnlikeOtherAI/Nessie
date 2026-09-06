import assert from 'node:assert/strict'
import test from 'node:test'

import { type ApiClient } from '@nessie/client-core'
import type { WebSearchCard } from '@nessie/schemas'
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
const { WebSearchResultsCard } = await import(
  '../src/components/features/channels/WebSearchResultsCard.js'
)
const { readWebSearchCard } = await import('@nessie/schemas')

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const domGlobals = {
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.window.navigator,
  window: dom.window,
}

const postedCard: WebSearchCard = {
  schemaVersion: 1,
  provider: 'serper',
  query: 'loch ness sightings',
  page: 1,
  count: 2,
  answer: 'A long-standing local legend.',
  results: [
    {
      position: 1,
      title: 'Loch Ness webcam',
      url: 'https://example.com/webcam',
      snippet: 'Watch the loch.',
      source: 'example.com',
    },
    {
      position: 2,
      title: 'Sightings archive',
      url: 'https://example.org/archive',
      snippet: 'Every reported sighting.',
      source: 'example.org',
    },
  ],
  related: ['loch ness weather'],
  hasMore: true,
}

const secondPage: WebSearchCard = {
  ...postedCard,
  page: 2,
  answer: undefined,
  related: undefined,
  results: [
    {
      position: 1,
      title: 'Page two result',
      url: 'https://example.net/two',
      snippet: 'Deeper in the results.',
      source: 'example.net',
    },
  ],
  hasMore: false,
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const withCard = async (
  post: ApiClient['post'],
  run: (container: HTMLElement) => Promise<void>,
) => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  const unavailable = async () => {
    throw new Error('Unexpected request')
  }
  const apiClient = {
    delete: unavailable,
    get: unavailable,
    patch: unavailable,
    post,
    put: unavailable,
  } as unknown as ApiClient
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(h(
        QueryClientProvider,
        { client: queryClient },
        h(
          ApiClientProvider,
          { client: apiClient },
          h(WebSearchResultsCard, { metadata: { webSearch: postedCard } }),
        ),
      ))
    })
    await run(container as unknown as HTMLElement)
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

test('the posted page renders from the message, spending nothing to open a thread', async () => {
  const post: ApiClient['post'] = async () => {
    throw new Error('A card must not search to render the page it was posted with')
  }

  await withCard(post, async (container) => {
    const text = container.textContent ?? ''
    assert.match(text, /loch ness sightings/)
    assert.match(text, /A long-standing local legend\./)
    assert.match(text, /Loch Ness webcam/)
    assert.match(text, /example\.org/)
    assert.match(text, /loch ness weather/)
    assert.match(text, /Page 1/)

    const links = [...container.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'))
    assert.ok(links.includes('https://example.com/webcam'))
    // Every result link leaves the app, so it must not carry the referrer or
    // reach back into the opener.
    for (const anchor of container.querySelectorAll('a')) {
      assert.equal(anchor.getAttribute('target'), '_blank')
      assert.match(anchor.getAttribute('rel') ?? '', /noopener/)
    }
  })
})

test('Next fetches the following page under the reader’s own identity', async () => {
  const calls: Array<{ path: string; body: unknown }> = []
  const post: ApiClient['post'] = async <TData,>(path: string, body?: unknown): Promise<TData> => {
    calls.push({ path, body })
    return secondPage as TData
  }

  await withCard(post, async (container) => {
    const next = [...container.querySelectorAll('button')].find(
      (button) => (button.textContent ?? '').includes('Next'),
    )
    assert.ok(next)
    await act(async () => {
      next.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await settle()
    })
    // A second tick: the click starts the search, the render that shows it
    // lands when the promise settles.
    await act(async () => {
      await settle()
    })

    assert.deepEqual(calls, [{
      path: '/api/web-search',
      body: { count: 2, page: 2, query: 'loch ness sightings' },
    }])
    const text = container.textContent ?? ''
    assert.match(text, /Page 2/)
    assert.match(text, /Page two result/)
    // The last page offers no next: hasMore is the provider's answer, not a guess.
    const nextAgain = [...container.querySelectorAll('button')].find(
      (button) => (button.textContent ?? '').includes('Next'),
    )
    assert.equal(nextAgain?.hasAttribute('disabled'), true)
  })
})

test('a link that is not http(s) takes the whole card out of the message', () => {
  assert.equal(
    readWebSearchCard({
      webSearch: {
        ...postedCard,
        results: [{ position: 1, title: 'Hostile', url: 'javascript:alert(1)' }],
      },
    }),
    null,
  )
})
