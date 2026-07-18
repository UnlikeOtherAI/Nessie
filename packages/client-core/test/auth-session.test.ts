import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAccessTokenRefreshCoordinator,
  createAuthSessionApi,
  type SessionPayload,
} from '../src/auth-session.js'

const sessionPayload = (token: string): SessionPayload => ({
  me: {} as SessionPayload['me'],
  token,
})

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

test('refresh returns null only for an explicit 401', async (t) => {
  await t.test('401 is an unauthenticated result', async () => {
    await withMockFetch(
      async (_input, init) => {
        assert.equal(init?.method, 'POST')
        assert.equal(init?.credentials, 'include')
        return new Response(null, { status: 401 })
      },
      async () => {
        assert.equal(await createAuthSessionApi('https://api.example.test').refresh(), null)
      },
    )
  })

  for (const status of [429, 503]) {
    await t.test(`${status} remains a transient error`, async () => {
      await withMockFetch(
        async () =>
          new Response(
            JSON.stringify({ error: { message: 'Please try again' } }),
            { status },
          ),
        async () => {
          await assert.rejects(
            createAuthSessionApi('https://api.example.test').refresh(),
            /Please try again/,
          )
        },
      )
    })
  }

  await t.test('network failure remains a transient error', async () => {
    await withMockFetch(
      async () => {
        throw new TypeError('Network unavailable')
      },
      async () => {
        await assert.rejects(
          createAuthSessionApi('https://api.example.test').refresh(),
          /Network unavailable/,
        )
      },
    )
  })
})

test('provider discovery surfaces failures to its independent retry owner', async () => {
  await withMockFetch(
    async () =>
      new Response(
        JSON.stringify({ error: { message: 'Provider service unavailable' } }),
        { status: 503 },
      ),
    async () => {
      await assert.rejects(
        createAuthSessionApi('https://api.example.test').fetchProviders(),
        /Provider service unavailable/,
      )
    },
  )
})

test('access-token refresh coordinator is single-flight', async () => {
  let resolveRefresh: ((payload: SessionPayload) => void) | undefined
  let refreshCalls = 0
  let applyCalls = 0
  let clearCalls = 0
  const refreshResult = new Promise<SessionPayload>((resolve) => {
    resolveRefresh = resolve
  })
  const refresh = createAccessTokenRefreshCoordinator({
    applySession: () => {
      applyCalls += 1
    },
    clearSession: () => {
      clearCalls += 1
    },
    refresh: () => {
      refreshCalls += 1
      return refreshResult
    },
  })

  const startupRenewal = refresh()
  const api401Renewal = refresh()
  assert.strictEqual(startupRenewal, api401Renewal)
  assert.equal(refreshCalls, 1)

  resolveRefresh?.(sessionPayload('renewed-token'))
  assert.deepEqual(
    await Promise.all([startupRenewal, api401Renewal]),
    ['renewed-token', 'renewed-token'],
  )
  assert.equal(applyCalls, 1)
  assert.equal(clearCalls, 0)
})

test('coordinator clears only on explicit rejection and retries transient failures', async () => {
  let refreshCalls = 0
  let applyCalls = 0
  let clearCalls = 0
  const refresh = createAccessTokenRefreshCoordinator({
    applySession: () => {
      applyCalls += 1
    },
    clearSession: () => {
      clearCalls += 1
    },
    refresh: async () => {
      refreshCalls += 1
      if (refreshCalls === 1) {
        throw new Error('Temporary outage')
      }
      return sessionPayload('recovered-token')
    },
  })

  await assert.rejects(refresh(), /Temporary outage/)
  assert.equal(clearCalls, 0)
  assert.equal(await refresh(), 'recovered-token')
  assert.equal(refreshCalls, 2)
  assert.equal(applyCalls, 1)
  assert.equal(clearCalls, 0)

  const rejectRefresh = createAccessTokenRefreshCoordinator({
    applySession: () => {
      applyCalls += 1
    },
    clearSession: () => {
      clearCalls += 1
    },
    refresh: async () => null,
  })
  assert.equal(await rejectRefresh(), null)
  assert.equal(clearCalls, 1)
})
