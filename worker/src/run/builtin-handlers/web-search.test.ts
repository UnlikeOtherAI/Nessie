import assert from 'node:assert/strict'
import test from 'node:test'

import { runWebSearch, WebSearchError } from './web-search.js'

const SERPER_BODY = {
  answerBox: { answer: '42' },
  organic: [
    {
      title: 'First result',
      link: 'https://example.com/one',
      snippet: 'A snippet about the first result.',
    },
    {
      title: 'Second result',
      link: 'https://example.com/two',
      snippet: 'A snippet about the second result.',
    },
    { title: 'No link result', snippet: 'dropped because it has no url' },
  ],
}

const makeFakeFetch = (
  responder: (url: string, init: RequestInit) => Response,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    const initObj: RequestInit = init ?? {}
    calls.push({ url, init: initObj })
    return responder(url, initObj)
  }
  return { fetchImpl, calls }
}

const withApiKey = async (value: string | undefined, fn: () => Promise<void>) => {
  const previous = process.env.SERPER_API_KEY
  if (value === undefined) {
    delete process.env.SERPER_API_KEY
  } else {
    process.env.SERPER_API_KEY = value
  }
  try {
    await fn()
  } finally {
    if (previous === undefined) {
      delete process.env.SERPER_API_KEY
    } else {
      process.env.SERPER_API_KEY = previous
    }
  }
}

test('runWebSearch returns answer, results, and snippets on success', async () => {
  await withApiKey('test-key', async () => {
    const { fetchImpl, calls } = makeFakeFetch(
      () =>
        new Response(JSON.stringify(SERPER_BODY), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )

    const result = await runWebSearch('meaning of life', { fetchImpl })

    assert.equal(result.query, 'meaning of life')
    assert.equal(result.answer, '42')
    assert.equal(result.results.length, 2)
    assert.deepEqual(result.results[0], {
      title: 'First result',
      url: 'https://example.com/one',
      snippet: 'A snippet about the first result.',
    })
    assert.match(result.text, /Answer: 42/)
    assert.match(result.text, /1\. First result - https:\/\/example\.com\/one/)

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, 'https://google.serper.dev/search')
    assert.equal(
      (calls[0]!.init.headers as Record<string, string>)['X-API-KEY'],
      'test-key',
    )
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      q: 'meaning of life',
      num: 5,
    })
  })
})

test('runWebSearch throws when SERPER_API_KEY is not configured', async () => {
  await withApiKey(undefined, async () => {
    await assert.rejects(
      () => runWebSearch('anything'),
      (error: unknown) =>
        error instanceof WebSearchError && /SERPER_API_KEY/.test(error.message),
    )
  })
})

test('runWebSearch throws on a non-empty query requirement', async () => {
  await withApiKey('test-key', async () => {
    await assert.rejects(
      () => runWebSearch('   '),
      (error: unknown) => error instanceof WebSearchError,
    )
  })
})

test('runWebSearch surfaces serper.dev HTTP errors', async () => {
  await withApiKey('test-key', async () => {
    const { fetchImpl } = makeFakeFetch(
      () => new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
    )

    await assert.rejects(
      () => runWebSearch('query', { fetchImpl }),
      (error: unknown) =>
        error instanceof WebSearchError && /403/.test(error.message),
    )
  })
})

test('runWebSearch reports no results without throwing', async () => {
  await withApiKey('test-key', async () => {
    const { fetchImpl } = makeFakeFetch(
      () =>
        new Response(JSON.stringify({ organic: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )

    const result = await runWebSearch('obscure query', { fetchImpl })
    assert.equal(result.results.length, 0)
    assert.equal(result.answer, null)
    assert.match(result.text, /No web results found/)
  })
})

test('runWebSearch clamps the result count to the supported range', async () => {
  await withApiKey('test-key', async () => {
    const { fetchImpl, calls } = makeFakeFetch(
      () =>
        new Response(JSON.stringify({ organic: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )

    await runWebSearch('query', { fetchImpl, count: 99 })
    assert.equal(JSON.parse(String(calls[0]!.init.body)).num, 10)
  })
})
