import assert from 'node:assert/strict'
import test from 'node:test'

import {
  beginExternalAuth,
  claimPendingExternalAuth,
  clearPendingExternalAuthMatching,
  createCompletedExternalAuthCallbackCache,
  readPendingExternalAuth,
  type PkceStorage,
} from '../src/pkce.js'

const memoryStorage = (): PkceStorage & { entries: Map<string, string> } => {
  const entries = new Map<string, string>()
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    removeItem: (key) => {
      entries.delete(key)
    },
    setItem: (key, value) => {
      entries.set(key, value)
    },
  }
}

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

const stubAuthorizeEndpoint = (): void => {
  globalThis.fetch = (async () =>
    Response.json({ data: { authorizeUrl: 'https://idp.example.com/auth' } })) as typeof fetch
}

const beginInput = (storage: PkceStorage) => ({
  baseUrl: 'https://api.example.com',
  providerId: 'uoa',
  redirectUri: 'nessie://auth/callback',
  storage,
})

test('beginExternalAuth persists the exact recovery target, team hint, and sanitized return path', async () => {
  await withMockFetch(globalThis.fetch, async () => {
    stubAuthorizeEndpoint()
    const storage = memoryStorage()
    await beginExternalAuth({
      ...beginInput(storage),
      returnPath: '/channels?filter=mine',
      targetWorkspace: { organizationId: 'uoa-org-1', teamId: 'uoa-team-9' },
      teamHint: 'uoa-team-9',
    })

    const pending = readPendingExternalAuth(storage)
    assert.equal(pending?.targetWorkspace?.organizationId, 'uoa-org-1')
    assert.equal(pending?.targetWorkspace?.teamId, 'uoa-team-9')
    assert.equal(pending?.teamHint, 'uoa-team-9')
    assert.equal(pending?.returnPath, '/channels?filter=mine')
  })
})

test('beginExternalAuth drops an external or oversized return path and hint', async () => {
  await withMockFetch(globalThis.fetch, async () => {
    stubAuthorizeEndpoint()
    const storage = memoryStorage()
    await beginExternalAuth({
      ...beginInput(storage),
      returnPath: 'https://evil.example.com/steal',
      teamHint: `hint-${'x'.repeat(600)}`,
    })

    const pending = readPendingExternalAuth(storage)
    assert.equal(pending?.returnPath, undefined)
    assert.equal(pending?.teamHint, undefined)
  })
})

test('beginExternalAuth refuses an unbounded target workspace', async () => {
  const storage = memoryStorage()
  await assert.rejects(
    beginExternalAuth({
      ...beginInput(storage),
      targetWorkspace: { organizationId: `org-${'x'.repeat(600)}`, teamId: 'team-1' },
    }),
    /bounded organization and team ids/,
  )
  assert.equal(readPendingExternalAuth(storage), null)
})

test('readPendingExternalAuth discards a malformed or tampered record', () => {
  const storage = memoryStorage()
  storage.setItem(
    'nessie.pendingExternalAuth',
    JSON.stringify({
      codeVerifier: 'verifier',
      providerId: 'uoa',
      state: 'state',
      targetWorkspace: { organizationId: 42, teamId: 'team-1' },
    }),
  )
  assert.equal(readPendingExternalAuth(storage), null)
  // The discarded record is cleared, not left for a later callback.
  assert.equal(storage.entries.size, 0)
})

test('an authorize request failure clears only the intent it launched', async () => {
  const storage = memoryStorage()
  await withMockFetch(
    (async () => new Response('unavailable', { status: 503 })) as typeof fetch,
    async () => {
      await assert.rejects(beginExternalAuth(beginInput(storage)), /unavailable/)
    },
  )
  assert.equal(readPendingExternalAuth(storage), null)
})

test('a stale mismatched callback preserves the newer pending intent', async () => {
  const storage = memoryStorage()
  await withMockFetch(
    (async () => Response.json({ data: { authorizeUrl: 'https://idp.example.com/auth' } })) as typeof fetch,
    async () => {
      await beginExternalAuth({ ...beginInput(storage), teamHint: 'new-team' })
    },
  )
  const newer = readPendingExternalAuth(storage)
  assert.ok(newer)

  const claim = claimPendingExternalAuth(storage, 'stale-state')
  assert.equal(claim.kind, 'state-mismatch')
  assert.deepEqual(readPendingExternalAuth(storage), newer)

  const matching = claimPendingExternalAuth(storage, newer.state)
  assert.equal(matching.kind, 'claimed')
  assert.deepEqual(readPendingExternalAuth(storage), newer)
  clearPendingExternalAuthMatching(storage, newer.state)
  assert.equal(readPendingExternalAuth(storage), null)
})

test('concurrent begins reserve one exact flow before the first await', async () => {
  const storage = memoryStorage()
  await withMockFetch(
    (async () => Response.json({ data: { authorizeUrl: 'https://idp.example/auth' } })) as typeof fetch,
    async () => {
      const first = beginExternalAuth({ ...beginInput(storage), teamHint: 'team-a' })
      await assert.rejects(
        beginExternalAuth({ ...beginInput(storage), teamHint: 'team-b' }),
        /already in progress/,
      )
      const result = await first
      const pending = readPendingExternalAuth(storage)
      assert.equal(result.state, pending?.state)
      assert.equal(pending?.teamHint, 'team-a')
    },
  )
})

test('a matched state-less flow remains single-flight until exact completion clears it', async () => {
  const storage = memoryStorage()
  await withMockFetch(
    (async () => Response.json({ data: { authorizeUrl: 'https://idp.example/auth' } })) as typeof fetch,
    async () => {
      const first = await beginExternalAuth({ ...beginInput(storage), teamHint: 'team-a' })
      assert.equal(claimPendingExternalAuth(storage, null).kind, 'claimed')
      await assert.rejects(beginExternalAuth(beginInput(storage)), /already in progress/)
      assert.equal(readPendingExternalAuth(storage)?.state, first.state)
      clearPendingExternalAuthMatching(storage, first.state)
      const second = await beginExternalAuth({ ...beginInput(storage), teamHint: 'team-b' })
      assert.notEqual(second.state, first.state)
    },
  )
})

test('completed callback replay cache survives adapter recreation and stays bounded', () => {
  const stored = memoryStorage()
  const first = createCompletedExternalAuthCallbackCache(stored)
  for (let index = 0; index < 17; index += 1) first.remember(`callback-${index}`)

  const recreatedAdapter: PkceStorage = {
    getItem: stored.getItem,
    removeItem: stored.removeItem,
    setItem: stored.setItem,
  }
  const recreated = createCompletedExternalAuthCallbackCache(recreatedAdapter)
  assert.equal(recreated.has('callback-0'), false)
  assert.equal(recreated.has('callback-1'), true)
  assert.equal(recreated.has('callback-16'), true)
})

test('completed callback replay cache discards malformed data without touching pending auth', async () => {
  const storage = memoryStorage()
  await withMockFetch(
    (async () => Response.json({ data: { authorizeUrl: 'https://idp.example/auth' } })) as typeof fetch,
    async () => beginExternalAuth(beginInput(storage)),
  )
  const pending = readPendingExternalAuth(storage)
  storage.setItem('nessie.completedExternalAuthCallbacks', JSON.stringify(['valid', 42]))

  const cache = createCompletedExternalAuthCallbackCache(storage)
  assert.equal(cache.has('valid'), false)
  assert.deepEqual(readPendingExternalAuth(storage), pending)
})
