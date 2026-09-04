import assert from 'node:assert/strict'
import test from 'node:test'

import { createApiClient } from '../src/api-client.js'

const withMockFetch = async (
  mock: typeof fetch,
  run: () => Promise<void>,
): Promise<void> => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('a billing 401 renews once and retries with the replacement access token', async () => {
  const requests: Array<{ authorization: string | null; url: string }> = []
  let refreshCalls = 0
  await withMockFetch(
    async (input, init) => {
      const headers = new Headers(init?.headers)
      requests.push({
        authorization: headers.get('authorization'),
        url: String(input),
      })
      if (requests.length === 1) {
        return Response.json(
          { error: { message: 'Session renewal required' } },
          { status: 401 },
        )
      }
      return Response.json({ data: { remainingCredits: 12_500 } })
    },
    async () => {
      const client = createApiClient({
        baseUrl: 'https://api.nessie.works/',
        token: 'expired-access-token',
        onUnauthorized: async () => {
          refreshCalls += 1
          return 'renewed-access-token'
        },
      })
      assert.deepEqual(
        await client.get('/api/billing/statement'),
        { remainingCredits: 12_500 },
      )
    },
  )

  assert.equal(refreshCalls, 1)
  assert.deepEqual(requests, [
    {
      authorization: 'Bearer expired-access-token',
      url: 'https://api.nessie.works/api/billing/statement',
    },
    {
      authorization: 'Bearer renewed-access-token',
      url: 'https://api.nessie.works/api/billing/statement',
    },
  ])
})

test('a rejected renewal surfaces the original 401 without retrying', async () => {
  let requestCalls = 0
  let refreshCalls = 0
  await withMockFetch(
    async () => {
      requestCalls += 1
      return Response.json(
        { error: { message: 'Session renewal required' } },
        { status: 401 },
      )
    },
    async () => {
      const client = createApiClient({
        baseUrl: 'https://api.nessie.works',
        token: 'expired-access-token',
        onUnauthorized: async () => {
          refreshCalls += 1
          return null
        },
      })
      await assert.rejects(
        client.post('/api/billing/top-ups', { credits: 50_000 }),
        /Session renewal required/,
      )
    },
  )

  assert.equal(requestCalls, 1)
  assert.equal(refreshCalls, 1)
})

test('a second 401 is terminal and never starts a renewal loop', async () => {
  let requestCalls = 0
  let refreshCalls = 0
  await withMockFetch(
    async () => {
      requestCalls += 1
      return Response.json(
        { error: { message: 'Session was revoked' } },
        { status: 401 },
      )
    },
    async () => {
      const client = createApiClient({
        baseUrl: 'https://api.nessie.works',
        token: 'expired-access-token',
        onUnauthorized: async () => {
          refreshCalls += 1
          return 'renewed-access-token'
        },
      })
      await assert.rejects(
        client.get('/api/billing/statement'),
        /Session was revoked/,
      )
    },
  )

  assert.equal(requestCalls, 2)
  assert.equal(refreshCalls, 1)
})

const pageResponse = () =>
  Response.json({
    data: [{ id: 'a' }, { id: 'b' }],
    meta: { hasMore: true, nextCursor: 'c2', prevCursor: null, total: 134 },
  })

test('getPage keeps the envelope, because a list lives in its meta', async () => {
  // `get` unwraps to `payload.data`, which is right for a record or an array
  // and silently wrong for a paged list: the cursors and the total are in
  // `meta`, and a caller that lost them rendered an empty list with no next
  // page reachable.
  await withMockFetch(
    async () => pageResponse(),
    async () => {
      const client = createApiClient({ baseUrl: 'https://api.nessie.works', token: 't' })

      const page = await client.getPage<Array<{ id: string }>>('/api/audit-log?limit=25')
      assert.deepEqual(page.data, [{ id: 'a' }, { id: 'b' }])
      assert.deepEqual(page.meta, {
        hasMore: true,
        nextCursor: 'c2',
        prevCursor: null,
        total: 134,
      })

      const unwrapped = await client.get<Array<{ id: string }>>('/api/audit-log?limit=25')
      assert.deepEqual(unwrapped, [{ id: 'a' }, { id: 'b' }], 'get still unwraps, unchanged')
    },
  )
})

test('getPage renews and retries on a 401 like every other method', async () => {
  let calls = 0
  await withMockFetch(
    async () => {
      calls += 1
      if (calls === 1) return Response.json({ error: { message: 'expired' } }, { status: 401 })
      return pageResponse()
    },
    async () => {
      const client = createApiClient({
        baseUrl: 'https://api.nessie.works',
        onUnauthorized: async () => 'renewed',
        token: 'expired',
      })

      const page = await client.getPage<Array<{ id: string }>>('/api/audit-log')
      assert.equal(calls, 2, 'the request is retried once after renewal')
      assert.equal(page.meta?.total, 134, 'the retry still returns the envelope')
    },
  )
})

test('a 204 through the envelope path reports no data rather than throwing', async () => {
  await withMockFetch(
    async () => new Response(null, { status: 204 }),
    async () => {
      const client = createApiClient({ baseUrl: 'https://api.nessie.works', token: 't' })

      const page = await client.getPage<null>('/api/thing')
      assert.equal(page.data, undefined)
      assert.equal(page.meta, undefined)
    },
  )
})

test('a caller can abort an in-flight post without bypassing session auth', async () => {
  const controller = new AbortController()
  let signal: AbortSignal | undefined
  await withMockFetch(
    async (_input, init) => {
      signal = init?.signal ?? undefined
      return Response.json({ data: { transcript: 'kept local' } })
    },
    async () => {
      const client = createApiClient({ baseUrl: 'https://api.nessie.works', token: 't' })
      await client.post('/api/voice/transcriptions', { audioBase64: 'AAAA' }, undefined, {
        signal: controller.signal,
      })
    },
  )

  assert.equal(signal, controller.signal)
})
