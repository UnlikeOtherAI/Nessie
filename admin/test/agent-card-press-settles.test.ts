import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

// A pressed card never looks un-pressed.
//
// The press can fail after the server resolved the card — a dropped
// connection, or another door winning the claim — and the hook used to
// refresh the card only on success, so a resolved card kept its Accept button
// live beside "Something went wrong". It refreshes the card and its thread
// when the press settles, whatever the outcome.

const CARD_ID = '77777777-7777-4777-8777-777777777777'
const THREAD_ID = '55555555-5555-4555-8555-555555555555'

const withDom = async (run: (dom: JSDOM) => Promise<void>): Promise<void> => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'https://app.example/',
  })
  const values = {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: dom.window.navigator,
    window: dom.window,
  }
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  try {
    await run(dom)
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    dom.window.close()
  }
}

const pressWith = async (post: () => Promise<unknown>): Promise<unknown[]> => {
  const invalidated: unknown[] = []
  await withDom(async (dom) => {
    const React = await import('react')
    const { act, createElement: h } = React
    const { createRoot } = await import('react-dom/client')
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
    const { ApiClientProvider } = await import('@nessie/client-core')
    const { useRespondToAgentCard } = await import('../src/facades/agent-cards/hooks')

    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const invalidate = queryClient.invalidateQueries.bind(queryClient)
    queryClient.invalidateQueries = ((filters?: { queryKey?: unknown }) => {
      invalidated.push(filters?.queryKey)
      return invalidate(filters)
    }) as typeof queryClient.invalidateQueries
    const apiClient = { post } as never

    let press = () => {}
    const Probe = () => {
      const respond = useRespondToAgentCard()
      press = () => respond.mutate(
        { actionKey: 'accept', cardId: CARD_ID, threadId: THREAD_ID },
        { onError: () => undefined },
      )
      return null
    }

    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(h(QueryClientProvider, { client: queryClient },
        h(ApiClientProvider, { client: apiClient }, h(Probe)))))
      await act(async () => {
        press()
        await new Promise((settle) => setTimeout(settle, 10))
      })
    } finally {
      await act(async () => root.unmount())
    }
  })
  return invalidated
}

test('a failed press still refreshes the card and its thread', async () => {
  const invalidated = await pressWith(async () => {
    throw new Error('Something went wrong')
  })
  assert.deepEqual(invalidated, [
    ['agent-cards', CARD_ID],
    ['threads', THREAD_ID, 'messages'],
  ])
})

test('a successful press refreshes the same two, once each', async () => {
  const invalidated = await pressWith(async () => ({
    cardId: CARD_ID,
    responseMessageId: '99999999-9999-4999-8999-999999999999',
    status: 'resolved',
  }))
  assert.deepEqual(invalidated, [
    ['agent-cards', CARD_ID],
    ['threads', THREAD_ID, 'messages'],
  ])
})
