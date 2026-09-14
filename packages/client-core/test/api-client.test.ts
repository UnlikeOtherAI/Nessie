import assert from 'node:assert/strict'
import test from 'node:test'

import { ChannelRecordSchema } from '@nessie/schemas'

import { ApiClientError, createApiClient } from '../src/api-client.js'

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

const channelRecord = {
  createdAt: '2026-09-12T12:00:00.000Z',
  defaultThreadId: '00000000-0000-4000-8000-000000000007',
  id: '00000000-0000-4000-8000-000000000001',
  label: 'Delivery',
  lastMessageAt: null,
  organizationId: '00000000-0000-4000-8000-000000000002',
  projectId: '00000000-0000-4000-8000-000000000003',
  projectName: 'Nessie',
  teamId: '00000000-0000-4000-8000-000000000004',
  teamName: 'Engineering',
  type: 'standard' as const,
  unreadCount: 0,
  updatedAt: '2026-09-12T12:00:00.000Z',
  viewerCanManage: true,
  visibility: 'public' as const,
}

test('rejects a malformed successful response envelope', async () => {
  await withMockFetch(
    async () => Response.json({ channels: [] }),
    async () => {
      const client = createApiClient({ baseUrl: 'https://api.nessie.works', token: 't' })
      await assert.rejects(
        client.get('/api/channels', ChannelRecordSchema.array()),
        (error: unknown) => error instanceof ApiClientError
          && error.code === 'INVALID_RESPONSE'
          && error.status === 200,
      )
    },
  )
})

for (const [description, payload] of [
  ['a missing data property', {}],
  ['an error-only object', { error: { code: 'NOPE', message: 'not a success envelope' } }],
] as const) {
  test(`generic get and getPage reject ${description}`, async () => {
    await withMockFetch(
      async () => Response.json(payload),
      async () => {
        const client = createApiClient({ baseUrl: 'https://api.nessie.works', token: 't' })
        const invalidResponse = (error: unknown): boolean => error instanceof ApiClientError
          && error.code === 'INVALID_RESPONSE'
          && error.status === 200

        await assert.rejects(client.get('/api/thing'), invalidResponse)
        await assert.rejects(client.getPage('/api/thing'), invalidResponse)
      },
    )
  })
}

test('generic get and getPage accept an explicit null data payload', async () => {
  await withMockFetch(
    async () => Response.json({ data: null, futureEnvelopeField: 'accepted' }),
    async () => {
      const client = createApiClient({ baseUrl: 'https://api.nessie.works', token: 't' })
      assert.equal(await client.get<null>('/api/thing'), null)
      assert.equal((await client.getPage<null>('/api/thing')).data, null)
    },
  )
})

test('rejects a record that omits an authoritative required field', async () => {
  const { label: _label, ...withoutLabel } = channelRecord
  await withMockFetch(
    async () => Response.json({ data: [withoutLabel] }),
    async () => {
      const client = createApiClient({ baseUrl: 'https://api.nessie.works', token: 't' })
      await assert.rejects(
        client.get('/api/channels', ChannelRecordSchema.array()),
        (error: unknown) => error instanceof ApiClientError
          && error.code === 'INVALID_RESPONSE',
      )
    },
  )
})

test('accepts additive fields when a canonical record schema parses a response', async () => {
  await withMockFetch(
    async () => Response.json({
      data: [{ ...channelRecord, futureServerField: 'accepted' }],
      meta: { hasMore: false, nextCursor: null, prevCursor: null },
    }),
    async () => {
      const client = createApiClient({ baseUrl: 'https://api.nessie.works', token: 't' })
      const page = await client.getPage('/api/channels', ChannelRecordSchema.array())

      assert.equal(page.data[0]?.id, channelRecord.id)
      assert.equal('futureServerField' in (page.data[0] ?? {}), false)
    },
  )
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
