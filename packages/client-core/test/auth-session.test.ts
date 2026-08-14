import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AuthSessionApiError,
  createAccessTokenRefreshCoordinator,
  createAuthSessionApi,
  createSessionMutationCoordinator,
  getAccessTokenExpiresAtMs,
  getAccessTokenRenewalDelayMs,
  type SessionPayload,
} from '../src/auth-session.js'

const sessionPayload = (token: string): SessionPayload => ({
  me: {} as SessionPayload['me'],
  token,
})

const unsignedJwt = (payload: Record<string, unknown>): string =>
  `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`

test('access-token renewal timing uses only a valid numeric expiry claim', () => {
  const token = unsignedJwt({ exp: 1_000 })
  assert.equal(getAccessTokenExpiresAtMs(token), 1_000_000)
  assert.equal(getAccessTokenRenewalDelayMs(token, 800_000, 120_000), 80_000)
  assert.equal(getAccessTokenRenewalDelayMs(token, 880_000, 120_000), 0)
  assert.equal(getAccessTokenRenewalDelayMs(token, 900_000, 120_000), 0)

  assert.equal(getAccessTokenExpiresAtMs(unsignedJwt({ exp: 'soon' })), null)
  assert.equal(getAccessTokenExpiresAtMs(unsignedJwt({ exp: Number.MAX_SAFE_INTEGER })), null)
  assert.equal(getAccessTokenRenewalDelayMs(unsignedJwt({}), 0), null)
  assert.equal(getAccessTokenRenewalDelayMs('not-a-jwt', 0), null)
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
  await t.test('200 returns the renewed session', async () => {
    await withMockFetch(
      async (_input, init) => {
        assert.equal(init?.method, 'POST')
        assert.equal(init?.credentials, 'include')
        return Response.json({ data: sessionPayload('renewed-token') })
      },
      async () => {
        assert.deepEqual(
          await createAuthSessionApi('https://api.example.test').refresh(),
          sessionPayload('renewed-token'),
        )
      },
    )
  })

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

test('UOA workspace switching sends the exact external target with both session proofs', async () => {
  await withMockFetch(
    async (input, init) => {
      assert.equal(input, 'https://api.example.test/api/auth/uoa/workspace')
      assert.equal(init?.method, 'POST')
      assert.equal(init?.credentials, 'include')
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('authorization'), 'Bearer access-token')
      assert.equal(headers.get('content-type'), 'application/json')
      assert.deepEqual(JSON.parse(String(init?.body)), {
        organizationId: 'external-org',
        teamId: 'external-team',
      })
      return Response.json({ data: sessionPayload('switched-token') })
    },
    async () => {
      assert.deepEqual(
        await createAuthSessionApi('https://api.example.test/').switchUoaWorkspace(
          'access-token',
          { organizationId: 'external-org', teamId: 'external-team' },
        ),
        sessionPayload('switched-token'),
      )
    },
  )
})

test('UOA workspace switching preserves the server error code and status', async () => {
  await withMockFetch(
    async () => Response.json(
      { error: { code: 'INTERACTION_REQUIRED', message: 'Verification required' } },
      { status: 403 },
    ),
    async () => {
      await assert.rejects(
        createAuthSessionApi('https://api.example.test').switchUoaWorkspace(
          'access-token',
          { organizationId: 'external-org', teamId: 'external-team' },
        ),
        (error: unknown) => {
          assert.ok(error instanceof AuthSessionApiError)
          assert.equal(error.code, 'INTERACTION_REQUIRED')
          assert.equal(error.status, 403)
          assert.equal(error.message, 'Verification required')
          return true
        },
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

test('session mutation coordinator makes refresh join an in-flight workspace switch', async () => {
  let resolveSwitch: ((payload: SessionPayload) => void) | undefined
  let refreshCalls = 0
  const applied: string[] = []
  const switchResult = new Promise<SessionPayload>((resolve) => {
    resolveSwitch = resolve
  })
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => applied.push(payload.token),
    clearSession: () => assert.fail('session must remain authenticated'),
    refresh: async () => {
      refreshCalls += 1
      return sessionPayload('unexpected-refresh')
    },
  })

  const switching = coordinator.run(() => switchResult)
  const renewing = coordinator.refresh()
  assert.equal(refreshCalls, 0)

  resolveSwitch?.(sessionPayload('switched-token'))
  assert.equal((await switching).token, 'switched-token')
  assert.equal(await renewing, 'switched-token')
  assert.deepEqual(applied, ['switched-token'])
})

test('logout suppresses an in-flight switch and deletes its winning session', async () => {
  let resolveSwitch: ((payload: SessionPayload) => void) | undefined
  const switchResult = new Promise<SessionPayload>((resolve) => {
    resolveSwitch = resolve
  })
  const events: string[] = []
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    refresh: async () => assert.fail('refresh is not part of logout'),
  })

  const switching = coordinator.run(() => switchResult)
  const logout = coordinator.terminate(async (latestPayload) => {
    events.push(`delete:${latestPayload?.token ?? 'none'}`)
  })
  const blockedMutation = coordinator.run(async () => {
    events.push('unexpected-mutation')
    return sessionPayload('unexpected-token')
  })

  await assert.rejects(blockedMutation, /session is being terminated/)
  assert.deepEqual(events, [])
  resolveSwitch?.(sessionPayload('switched-token'))

  await assert.rejects(switching, /session is being terminated/)
  await logout
  assert.deepEqual(events, ['delete:switched-token', 'clear'])
})

test('logout still deletes and clears after an in-flight mutation rejects', async () => {
  let rejectSwitch: ((error: Error) => void) | undefined
  const switchResult = new Promise<SessionPayload>((_resolve, reject) => {
    rejectSwitch = reject
  })
  const events: string[] = []
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    refresh: async () => assert.fail('refresh is not part of logout'),
  })

  const switching = coordinator.run(() => switchResult)
  const logout = coordinator.terminate(async (latestPayload) => {
    events.push(`delete:${latestPayload?.token ?? 'none'}`)
  })
  rejectSwitch?.(new Error('switch failed'))

  await assert.rejects(switching, /switch failed/)
  await logout
  assert.deepEqual(events, ['delete:none', 'clear'])
})

test('logout suppresses a session waiting at its cache-reset boundary', async () => {
  let enterBoundary: (() => void) | undefined
  let releaseBoundary: (() => void) | undefined
  const boundaryEntered = new Promise<void>((resolve) => {
    enterBoundary = resolve
  })
  const boundaryRelease = new Promise<void>((resolve) => {
    releaseBoundary = resolve
  })
  const events: string[] = []
  const coordinator = createSessionMutationCoordinator({
    beforeApply: async () => {
      events.push('before-apply')
      enterBoundary?.()
      await boundaryRelease
    },
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    refresh: async () => assert.fail('refresh is not part of logout'),
  })

  const switching = coordinator.run(async () => sessionPayload('switched-token'))
  await boundaryEntered
  const logout = coordinator.terminate(async (latestPayload) => {
    events.push(`delete:${latestPayload?.token ?? 'none'}`)
  })
  releaseBoundary?.()

  await assert.rejects(switching, /session is being terminated/)
  await logout
  assert.deepEqual(events, ['before-apply', 'delete:switched-token', 'clear'])
})

test('session mutation coordinator exposes the refreshed payload and token-only API', async () => {
  let resolveRefresh: ((payload: SessionPayload) => void) | undefined
  let refreshCalls = 0
  const refreshResult = new Promise<SessionPayload>((resolve) => {
    resolveRefresh = resolve
  })
  const coordinator = createSessionMutationCoordinator({
    applySession: () => undefined,
    clearSession: () => assert.fail('session must remain authenticated'),
    refresh: () => {
      refreshCalls += 1
      return refreshResult
    },
  })

  const reconciling = coordinator.reconcile()
  const refreshing = coordinator.refresh()
  assert.equal(refreshCalls, 1)

  const payload = sessionPayload('renewed-token')
  resolveRefresh?.(payload)
  assert.equal(await reconciling, payload)
  assert.equal(await refreshing, 'renewed-token')
})

test('payload reconciliation refreshes after a failed explicit mutation', async () => {
  let refreshCalls = 0
  const coordinator = createSessionMutationCoordinator({
    applySession: () => undefined,
    clearSession: () => assert.fail('session must remain authenticated'),
    refresh: async () => {
      refreshCalls += 1
      return sessionPayload('reconciled-token')
    },
  })

  await assert.rejects(
    coordinator.run(async () => {
      throw new TypeError('response body was lost')
    }),
    /response body was lost/,
  )

  assert.equal((await coordinator.reconcile())?.token, 'reconciled-token')
  assert.equal(refreshCalls, 1)
})

test('session mutation coordinator runs its global before-apply for every mutation', async () => {
  let resolveRefresh: ((payload: SessionPayload) => void) | undefined
  let currentToken = 'old-token'
  const events: string[] = []
  const refreshResult = new Promise<SessionPayload>((resolve) => {
    resolveRefresh = resolve
  })
  const coordinator = createSessionMutationCoordinator({
    beforeApply: (payload) => {
      events.push(`before:${payload.token}`)
    },
    applySession: (payload) => {
      currentToken = payload.token
      events.push(`apply:${payload.token}`)
    },
    clearSession: () => assert.fail('session must remain authenticated'),
    refresh: () => refreshResult,
  })

  const renewing = coordinator.refresh()
  const switching = coordinator.run(async () => {
    events.push(`switch:${currentToken}`)
    return sessionPayload('switched-token')
  })

  resolveRefresh?.(sessionPayload('renewed-token'))
  assert.equal(await renewing, 'renewed-token')
  assert.equal((await switching).token, 'switched-token')
  assert.deepEqual(events, [
    'before:renewed-token',
    'apply:renewed-token',
    'switch:renewed-token',
    'before:switched-token',
    'apply:switched-token',
  ])
})
