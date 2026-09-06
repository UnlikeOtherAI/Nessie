import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  LedgerAttribution,
  LedgerIdentityHeadersOptions,
  LedgerIdentityService,
} from '@nessie/runtime'

import {
  runWebSearch,
  WebSearchError,
  type WebSearchOptions,
} from '../src/web-search.js'

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

const attribution: LedgerAttribution = {
  actorId: '00000000-0000-0000-0000-000000000001',
  actorType: 'user',
  agentId: '00000000-0000-0000-0000-000000000002',
  agentKind: 'personal_assistant',
  organizationId: '00000000-0000-0000-0000-000000000003',
  requestId: 'request-1',
  runId: '00000000-0000-0000-0000-000000000004',
  teamId: '00000000-0000-0000-0000-000000000005',
  userId: '00000000-0000-0000-0000-000000000001',
}

const ledgerEnv: NodeJS.ProcessEnv = {
  LEDGER_PROXY_TOKEN: 'lk_nessie_test',
  LEDGER_PUBLIC_URL: 'https://ledger.example/base-that-must-not-leak',
}

const makeFakeFetch = (
  responder: (url: string, init: RequestInit) => Response,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input.toString()
    const initObj: RequestInit = init ?? {}
    calls.push({ url, init: initObj })
    return responder(url, initObj)
  }
  return { fetchImpl, calls }
}

const makeIdentity = (
  headers: Record<string, string> = {
    'X-Nessie-Context': 'signed-nessie-context',
    'X-UOA-Delegation': 'signed-uoa-delegation',
  },
): {
  calls: Array<{
    attribution: LedgerAttribution
    options: LedgerIdentityHeadersOptions | undefined
  }>
  identity: LedgerIdentityService
} => {
  const calls: Array<{
    attribution: LedgerAttribution
    options: LedgerIdentityHeadersOptions | undefined
  }> = []
  return {
    calls,
    identity: {
      requestHeaders: async (input, options) => {
        calls.push({ attribution: input, options })
        return headers
      },
    },
  }
}

const options = (
  overrides: Partial<WebSearchOptions> = {},
): WebSearchOptions => {
  const { identity } = makeIdentity()
  return {
    attribution,
    env: ledgerEnv,
    ledgerIdentity: identity,
    toolCallId: 'provider-tool-call-1',
    ...overrides,
  }
}

test('runWebSearch routes through Ledger with signed exact provenance', async () => {
  const { fetchImpl, calls } = makeFakeFetch(
    () =>
      new Response(JSON.stringify(SERPER_BODY), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )
  const signing = makeIdentity()

  const result = await runWebSearch('meaning of life', {
    attribution,
    env: ledgerEnv,
    fetchImpl,
    ledgerIdentity: signing.identity,
    toolCallId: 'provider-tool-call-7',
  })

  assert.equal(result.query, 'meaning of life')
  assert.equal(result.answer, '42')
  assert.equal(result.results.length, 2)
  assert.deepEqual(result.results[0], {
    position: 1,
    title: 'First result',
    url: 'https://example.com/one',
    snippet: 'A snippet about the first result.',
    source: 'example.com',
  })
  assert.equal(result.provider, 'serper')
  assert.match(result.text, /Answer: 42/)
  assert.match(result.text, /1\. First result - https:\/\/example\.com\/one/)

  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, 'https://ledger.example/v1/serper/search')
  const requestHeaders = new Headers(calls[0]!.init.headers)
  assert.equal(requestHeaders.get('authorization'), 'Bearer lk_nessie_test')
  assert.equal(requestHeaders.get('x-nessie-context'), 'signed-nessie-context')
  assert.equal(requestHeaders.get('x-uoa-delegation'), 'signed-uoa-delegation')
  assert.equal(requestHeaders.get('x-api-key'), null)
  assert.equal(requestHeaders.get('x-ledger-app-key'), null)
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    q: 'meaning of life',
    num: 5,
    page: 1,
  })
  assert.equal(signing.calls.length, 1)
  assert.equal(signing.calls[0]!.attribution.toolCallId, 'provider-tool-call-7')
  assert.equal(signing.calls[0]!.options?.toolCallId, 'provider-tool-call-7')
  assert.equal(
    signing.calls[0]!.attribution.organizationId,
    attribution.organizationId,
  )
  assert.equal(signing.calls[0]!.attribution.teamId, attribution.teamId)
  assert.equal(signing.calls[0]!.attribution.userId, attribution.userId)
  assert.equal(signing.calls[0]!.attribution.agentId, attribution.agentId)
  assert.equal(signing.calls[0]!.attribution.runId, attribution.runId)
})

test('runWebSearch forwards and clamps page and result count', async () => {
  const { fetchImpl, calls } = makeFakeFetch(
    () =>
      new Response(JSON.stringify({ organic: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )

  const paged = await runWebSearch('deep query', options({
    count: 99,
    fetchImpl,
    page: 3,
  }))
  assert.equal(paged.page, 3)
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    q: 'deep query',
    num: 10,
    page: 3,
  })

  const clamped = await runWebSearch('query', options({
    fetchImpl,
    page: 0,
  }))
  assert.equal(clamped.page, 1)
  assert.equal(JSON.parse(String(calls[1]!.init.body)).page, 1)
})

test('runWebSearch fails closed without Ledger URL or Nessie app key', async () => {
  for (const env of [
    { LEDGER_PROXY_TOKEN: 'lk_nessie_test' },
    { LEDGER_PUBLIC_URL: 'https://ledger.example' },
  ]) {
    await assert.rejects(
      () => runWebSearch('anything', options({ env })),
      (error: unknown) =>
        error instanceof WebSearchError
        && /LEDGER_PUBLIC_URL and LEDGER_PROXY_TOKEN/.test(error.message),
    )
  }
})

test('runWebSearch fails closed without signing identity or tool call ID', async () => {
  await assert.rejects(
    () => runWebSearch('anything', options({ ledgerIdentity: null })),
    (error: unknown) =>
      error instanceof WebSearchError && /signing identity/.test(error.message),
  )
  await assert.rejects(
    () => runWebSearch('anything', options({ toolCallId: '  ' })),
    (error: unknown) =>
      error instanceof WebSearchError && /stable tool call ID/.test(error.message),
  )
})

test('runWebSearch rejects an invalid Ledger URL before dispatch', async () => {
  const { fetchImpl, calls } = makeFakeFetch(
    () => new Response(JSON.stringify(SERPER_BODY), { status: 200 }),
  )
  await assert.rejects(
    () => runWebSearch('anything', options({
      env: {
        LEDGER_PROXY_TOKEN: 'lk_nessie_test',
        LEDGER_PUBLIC_URL: 'file:///tmp/ledger',
      },
      fetchImpl,
    })),
    (error: unknown) =>
      error instanceof WebSearchError && /valid HTTP\(S\) URL/.test(error.message),
  )
  assert.equal(calls.length, 0)
})

test('runWebSearch rejects unexpected signer headers before dispatch', async () => {
  const { fetchImpl, calls } = makeFakeFetch(
    () => new Response(JSON.stringify(SERPER_BODY), { status: 200 }),
  )
  const { identity } = makeIdentity({
    Authorization: 'attacker-controlled',
    'X-Nessie-Context': 'signed',
  })

  await assert.rejects(
    () => runWebSearch('anything', options({
      fetchImpl,
      ledgerIdentity: identity,
    })),
    (error: unknown) =>
      error instanceof WebSearchError && /unexpected header/.test(error.message),
  )
  assert.equal(calls.length, 0)
})

test('runWebSearch requires a non-empty query', async () => {
  await assert.rejects(
    () => runWebSearch('   ', options()),
    (error: unknown) => error instanceof WebSearchError,
  )
})

test('runWebSearch surfaces Ledger HTTP errors', async () => {
  const { fetchImpl } = makeFakeFetch(
    () => new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
  )

  await assert.rejects(
    () => runWebSearch('query', options({ fetchImpl })),
    (error: unknown) =>
      error instanceof WebSearchError
      && /Ledger web search returned 403/.test(error.message),
  )
})

test('runWebSearch reports no results without throwing', async () => {
  const { fetchImpl } = makeFakeFetch(
    () =>
      new Response(JSON.stringify({ organic: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )

  const result = await runWebSearch(
    'obscure query',
    options({ fetchImpl }),
  )
  assert.equal(result.results.length, 0)
  assert.equal(result.answer, null)
  assert.match(result.text, /No web results found/)
})

const CANONICAL_BODY = {
  search: {
    provider: 'brave',
    vertical: 'web',
    q: 'meaning of life',
    page: 2,
    results: [
      {
        position: 1,
        title: 'Canonical first',
        url: 'https://example.org/one',
        snippet: 'From whichever provider answered.',
        date: '3 days ago',
      },
      { position: 2, title: 'No url', snippet: 'dropped' },
      { position: 3, title: 'Canonical second', url: 'https://example.net/two' },
    ],
    knowledge_graph: {
      title: 'Meaning of life',
      url: 'https://example.org/panel',
      description: 'A philosophical question.',
    },
    related: ['meaning of life 42', 'absurdism'],
    fidelity: 'full',
  },
}

test('a configured search Purpose API addresses the purpose route, not a provider', async () => {
  const { fetchImpl, calls } = makeFakeFetch(
    () =>
      new Response(JSON.stringify(CANONICAL_BODY), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )

  const result = await runWebSearch('meaning of life', options({
    env: { ...ledgerEnv, NESSIE_LEDGER_SEARCH_PURPOSE_API_ID: 'pa_search_1' },
    fetchImpl,
    page: 2,
  }))

  assert.equal(calls[0]!.url, 'https://ledger.example/v1/purpose/pa_search_1/search')
  // The Purpose API's request schema is strict: nothing may be added here.
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    q: 'meaning of life',
    num: 5,
    page: 2,
  })
  // Whichever provider Ledger walked to is reported, not assumed.
  assert.equal(result.provider, 'brave')
  assert.equal(result.results.length, 2)
  assert.deepEqual(result.results[0], {
    position: 1,
    title: 'Canonical first',
    url: 'https://example.org/one',
    snippet: 'From whichever provider answered.',
    date: '3 days ago',
    source: 'example.org',
  })
  // A dropped result renumbers rather than leaving a gap at rank 2.
  assert.equal(result.results[1]!.position, 2)
  assert.deepEqual(result.related, ['meaning of life 42', 'absurdism'])
  assert.deepEqual(result.knowledgePanel, {
    title: 'Meaning of life',
    description: 'A philosophical question.',
    url: 'https://example.org/panel',
  })
  assert.equal(result.answer, 'A philosophical question.')
  assert.match(result.text, /Related searches: meaning of life 42, absurdism/)
})

test('hasMore is true only when the page came back full', async () => {
  const oneResult = {
    organic: [{ title: 'Only', link: 'https://example.com/only', snippet: 'one' }],
  }
  const { fetchImpl } = makeFakeFetch(
    () =>
      new Response(JSON.stringify(oneResult), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )

  const short = await runWebSearch('query', options({ count: 5, fetchImpl }))
  assert.equal(short.hasMore, false)

  const full = await runWebSearch('query', options({ count: 1, fetchImpl }))
  assert.equal(full.hasMore, true)
})

test('an unrecognised body is refused rather than reported as no results', async () => {
  const { fetchImpl } = makeFakeFetch(
    () =>
      new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )

  await assert.rejects(
    () => runWebSearch('query', options({ fetchImpl })),
    (error: unknown) =>
      error instanceof WebSearchError && /unexpected response shape/.test(error.message),
  )
})
