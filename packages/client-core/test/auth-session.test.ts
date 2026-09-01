import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AuthSessionApiError,
  createAuthSessionApi,
  SessionMutationLoss,
  getAccessTokenExpiresAtMs,
  getAccessTokenRenewalDelayMs,
  sessionMatchesExpectedWorkspace,
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

test('session mutation requests identify a native shell without changing browser defaults', async () => {
  await withMockFetch(
    async (_input, init) => {
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('x-nessie-session-client'), 'native-ios')
      return Response.json({ data: sessionPayload('renewed-token') })
    },
    async () => {
      await createAuthSessionApi('https://api.example.test', {
        sessionClient: () => 'native-ios',
      }).refresh()
    },
  )
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

test('sessionMatchesExpectedWorkspace requires the exact active UOA org and team', () => {
  const targeted = {
    me: {
      uoaWorkspaces: [
        { active: false, organizationId: 'org-a', teamId: 'team-a' },
        { active: true, organizationId: 'org-b', teamId: 'team-b' },
      ],
    },
    token: 'token',
  } as unknown as SessionPayload

  assert.equal(
    sessionMatchesExpectedWorkspace(targeted, { organizationId: 'org-b', teamId: 'team-b' }),
    true,
  )
  assert.equal(
    sessionMatchesExpectedWorkspace(targeted, { organizationId: 'org-a', teamId: 'team-a' }),
    false,
  )
  assert.equal(
    sessionMatchesExpectedWorkspace(targeted, { organizationId: 'org-b', teamId: 'team-c' }),
    false,
  )
  assert.equal(
    sessionMatchesExpectedWorkspace(
      sessionPayload('no-directory'),
      { organizationId: 'org-b', teamId: 'team-b' },
    ),
    false,
  )

  // Ambiguous multiple-active responses are rejected, even when one matches.
  const ambiguous = {
    me: {
      uoaWorkspaces: [
        { active: true, organizationId: 'org-b', teamId: 'team-b' },
        { active: true, organizationId: 'org-a', teamId: 'team-a' },
      ],
    },
    token: 'token',
  } as unknown as SessionPayload
  assert.equal(
    sessionMatchesExpectedWorkspace(ambiguous, { organizationId: 'org-b', teamId: 'team-b' }),
    false,
  )

  // An empty active set never matches.
  const noneActive = {
    me: {
      uoaWorkspaces: [{ active: false, organizationId: 'org-b', teamId: 'team-b' }],
    },
    token: 'token',
  } as unknown as SessionPayload
  assert.equal(
    sessionMatchesExpectedWorkspace(noneActive, { organizationId: 'org-b', teamId: 'team-b' }),
    false,
  )
})

test('recoverWorkspaceSession sends the bearer proof and exact expected workspace to POST /api/auth/session', async () => {
  await withMockFetch(
    async (input, init) => {
      assert.equal(input, 'https://api.example.test/api/auth/session')
      assert.equal(init?.method, 'POST')
      assert.equal(init?.credentials, 'include')
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('authorization'), 'Bearer current-access-token')
      assert.equal(headers.get('content-type'), 'application/json')
      assert.deepEqual(JSON.parse(String(init?.body)), {
        code: 'auth-code',
        codeVerifier: 'pkce-verifier',
        expectedWorkspace: { organizationId: 'external-org', teamId: 'external-team' },
        providerId: 'uoa',
        redirectUri: 'https://app.example.test/callback',
      })
      return Response.json({ data: sessionPayload('recovered-token') })
    },
    async () => {
      assert.deepEqual(
        await createAuthSessionApi('https://api.example.test/').recoverWorkspaceSession(
          'current-access-token',
          {
            code: 'auth-code',
            codeVerifier: 'pkce-verifier',
            expectedWorkspace: { organizationId: 'external-org', teamId: 'external-team' },
            providerId: 'uoa',
            redirectUri: 'https://app.example.test/callback',
          },
        ),
        sessionPayload('recovered-token'),
      )
    },
  )
})

test('recoverWorkspaceSession refuses a missing or empty bearer locally', async () => {
  let fetchCalls = 0
  await withMockFetch(
    async () => {
      fetchCalls += 1
      return Response.json({ data: sessionPayload('unreached') })
    },
    async () => {
      const api = createAuthSessionApi('https://api.example.test')
      const input = {
        code: 'auth-code',
        codeVerifier: 'pkce-verifier',
        expectedWorkspace: { organizationId: 'external-org', teamId: 'external-team' },
        providerId: 'uoa' as const,
        redirectUri: 'https://app.example.test/callback',
      }
      await assert.rejects(
        api.recoverWorkspaceSession(null as unknown as string, input),
        /requires an authenticated bearer token/,
      )
      await assert.rejects(
        api.recoverWorkspaceSession('', input),
        /requires an authenticated bearer token/,
      )
      assert.equal(fetchCalls, 0)
    },
  )
})

test('ordinary login stays bearer-free even on the same session route', async () => {
  await withMockFetch(
    async (input, init) => {
      assert.equal(input, 'https://api.example.test/api/auth/session')
      assert.equal(init?.method, 'POST')
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('authorization'), null)
      assert.deepEqual(JSON.parse(String(init?.body)), {
        email: 'person@example.test',
        password: 'secret',
      })
      return Response.json({ data: sessionPayload('login-token') })
    },
    async () => {
      assert.deepEqual(
        await createAuthSessionApi('https://api.example.test').login({
          email: 'person@example.test',
          password: 'secret',
        }),
        sessionPayload('login-token'),
      )
    },
  )
})

test('logout is bound to the bearer and never sends the ambient refresh cookie', async () => {
  await withMockFetch(
    async (input, init) => {
      assert.equal(input, 'https://api.example.test/api/auth/session')
      assert.equal(init?.method, 'DELETE')
      assert.equal(init?.credentials, 'omit')
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        'Bearer old-access-token',
      )
      return new Response(null, { status: 204 })
    },
    async () => {
      await createAuthSessionApi('https://api.example.test').logout('old-access-token')
    },
  )
})

test('a lost session response surfaces as an opaque SessionMutationLoss, never a status error', async (t) => {
  await t.test('transport failure', async () => {
    await withMockFetch(
      async () => {
        throw new TypeError('Network unavailable')
      },
      async () => {
        await assert.rejects(
          createAuthSessionApi('https://api.example.test').login({
            email: 'person@example.test',
            password: 'secret',
          }),
          (error: unknown) => {
            assert.ok(error instanceof SessionMutationLoss)
            assert.match(error.message, /lost in transit/)
            return true
          },
        )
      },
    )
  })

  await t.test('unreadable success body', async () => {
    await withMockFetch(
      async () =>
        new Response('not-json', {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      async () => {
        await assert.rejects(
          createAuthSessionApi('https://api.example.test').recoverWorkspaceSession(
            'current-access-token',
            {
              code: 'auth-code',
              codeVerifier: 'pkce-verifier',
              expectedWorkspace: { organizationId: 'external-org', teamId: 'external-team' },
              providerId: 'uoa',
              redirectUri: 'https://app.example.test/callback',
            },
          ),
          (error: unknown) => {
            assert.ok(error instanceof SessionMutationLoss)
            assert.match(error.message, /could not be read/)
            return true
          },
        )
      },
    )
  })

  await t.test('a delivered HTTP status stays typed and is never opaque', async () => {
    await withMockFetch(
      async () => Response.json(
        { error: { code: 'WORKSPACE_MISMATCH', message: 'Wrong workspace' } },
        { status: 409 },
      ),
      async () => {
        await assert.rejects(
          createAuthSessionApi('https://api.example.test').login({
            email: 'person@example.test',
            password: 'secret',
          }),
          (error: unknown) => {
            assert.ok(error instanceof AuthSessionApiError)
            assert.equal(error.code, 'WORKSPACE_MISMATCH')
            assert.equal(error.status, 409)
            return true
          },
        )
      },
    )
  })
})
