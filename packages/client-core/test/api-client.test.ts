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
