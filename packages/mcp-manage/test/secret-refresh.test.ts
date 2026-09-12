import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  AT_REST_SECRET_PURPOSE,
  decryptWithKeyRing,
  deriveSecretKey,
  encryptWithKey,
  encryptWithKeyRing,
} from '@nessie/runtime'

import {
  createPgSecretResolver,
  createPgSecretStore,
} from '../src/index.js'

/**
 * Auto-refresh behaviour of the encrypted secret store: an expired bundle
 * with refresh metadata is renewed in place via a refresh_token grant; a
 * bundle without metadata (or a refusing provider) hands back the stale
 * token so the downstream 401 stays visible.
 */

const SECRET = 'unit-test-encryption-secret'
const TOKEN_ENDPOINT = 'https://93.184.216.35/token'

const makePrisma = (): {
  prisma: PrismaClient
  rows: Map<string, { ref: string; ciphertext: string; iv: string; authTag: string }>
  state: { updates: number }
} => {
  const rows = new Map<string, { ref: string; ciphertext: string; iv: string; authTag: string }>()
  const state = { updates: 0 }
  let transactionTail = Promise.resolve()
  let prisma: PrismaClient
  const runTransaction = async <T>(work: (tx: never) => Promise<T>): Promise<T> => {
    const previous = transactionTail
    let release!: () => void
    transactionTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await work(prisma as never)
    } finally {
      release()
    }
  }
  prisma = {
    $executeRaw: async () => 0,
    $transaction: runTransaction,
    mcpOAuthSecret: {
      create: async ({ data }: { data: { ref: string; ciphertext: string; iv: string; authTag: string } }) => {
        rows.set(data.ref, data)
        return data
      },
      findUnique: async ({ where }: { where: { ref: string } }) => rows.get(where.ref) ?? null,
      updateMany: async ({ where, data }: {
        where: { ref: string; ciphertext: string; iv: string; authTag: string }
        data: { ciphertext: string; iv: string; authTag: string }
      }) => {
        const existing = rows.get(where.ref)
        if (
          !existing
          || existing.ciphertext !== where.ciphertext
          || existing.iv !== where.iv
          || existing.authTag !== where.authTag
        ) return { count: 0 }
        state.updates += 1
        rows.set(where.ref, { ...existing, ...data })
        return { count: 1 }
      },
    },
  } as unknown as PrismaClient
  return { prisma, rows, state }
}
test('resolver refreshes an expired token and persists the renewed bundle', async () => {
  const { prisma, state } = makePrisma()
  const store = createPgSecretStore(prisma, SECRET)
  const ref = await store.put({
    accessToken: 'stale-token',
    refreshToken: 'refresh-1',
    expiresIn: -10, // already expired
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: 'client-1',
    resource: 'https://93.184.216.34/mcp',
  })

  let refreshBody: URLSearchParams | null = null
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    refreshBody = new URLSearchParams(String(init?.body))
    return new Response(
      JSON.stringify({ access_token: 'fresh-token', refresh_token: 'refresh-2', expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch

  const resolver = createPgSecretResolver(prisma, SECRET, { fetchImpl })
  const first = await resolver.resolve(ref)
  assert.equal(first, 'fresh-token')
  assert.equal(state.updates, 1)
  assert.equal(refreshBody!.get('grant_type'), 'refresh_token')
  assert.equal(refreshBody!.get('refresh_token'), 'refresh-1')
  assert.equal(refreshBody!.get('client_id'), 'client-1')
  assert.equal(refreshBody!.get('resource'), 'https://93.184.216.34/mcp')

  // Second resolve: renewed bundle is fresh — no further refresh call.
  const second = await resolver.resolve(ref)
  assert.equal(second, 'fresh-token')
  assert.equal(state.updates, 1)
})

test('resolver returns the stale token when the provider refuses the refresh', async () => {
  const { prisma, state } = makePrisma()
  const store = createPgSecretStore(prisma, SECRET)
  const ref = await store.put({
    accessToken: 'stale-token',
    refreshToken: 'refresh-1',
    expiresIn: -10,
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: 'client-1',
  })
  const fetchImpl = (async () => new Response('nope', { status: 400 })) as typeof fetch
  const resolver = createPgSecretResolver(prisma, SECRET, { fetchImpl })
  assert.equal(await resolver.resolve(ref), 'stale-token')
  assert.equal(state.updates, 0)
})

test('bundles without refresh metadata resolve without any network traffic', async () => {
  const { prisma } = makePrisma()
  const store = createPgSecretStore(prisma, SECRET, { refPrefix: 'secret_mcp_' })
  const ref = await store.put({ accessToken: 'api-key-123' })
  const fetchImpl = (async () => {
    throw new Error('must not fetch')
  }) as typeof fetch
  const resolver = createPgSecretResolver(prisma, SECRET, { fetchImpl })
  assert.equal(await resolver.resolve(ref), 'api-key-123')
  assert.equal(await resolver.resolve('secret_unknown_ref'), null)
  assert.equal(await resolver.resolve('NOT_A_SECRET_REF'), null)
})

const rotationRing = {
  activeVersion: '2026-09',
  keys: {
    '2026-06': 'retained-root-for-secret-refresh-tests',
    '2026-09': 'active-root-for-secret-refresh-tests',
  },
  legacyKey: SECRET,
} as const

const expiredBundle = (refreshToken: string) => ({
  accessToken: 'stale-token',
  clientId: 'client-1',
  expiresAt: 0,
  refreshToken,
  tokenEndpoint: TOKEN_ENDPOINT,
})

test('refreshes legacy and prior-version credentials without dropping a rotated provider token', async () => {
  const priorWriteRing = {
    activeVersion: '2026-06',
    keys: rotationRing.keys,
    legacyKey: SECRET,
  } as const
  const cases = [
    {
      encrypted: (bundle: string) => encryptWithKey(deriveSecretKey(SECRET), bundle),
      name: 'legacy ciphertext',
    },
    {
      encrypted: (bundle: string) => encryptWithKeyRing(
        priorWriteRing,
        AT_REST_SECRET_PURPOSE.mcpOauth,
        bundle,
      ),
      name: 'retained prior-version envelope',
    },
  ]

  for (const { encrypted, name } of cases) {
    const { prisma, rows, state } = makePrisma()
    const ref = 'secret_oauth_' + name.replaceAll(/[^a-z]/gu, '')
    const initial = encrypted(JSON.stringify(expiredBundle('refresh-1')))
    rows.set(ref, { ref, ...initial })
    const fetchImpl = (async () => new Response(
      JSON.stringify({
        access_token: 'fresh-token',
        expires_in: 3600,
        refresh_token: 'refresh-2',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch

    const resolver = createPgSecretResolver(prisma, rotationRing, { fetchImpl })
    assert.equal(await resolver.resolve(ref), 'fresh-token', name)
    assert.equal(state.updates, 1, name)
    const stored = rows.get(ref)
    assert.ok(stored, name)
    const opened = decryptWithKeyRing(
      rotationRing,
      AT_REST_SECRET_PURPOSE.mcpOauth,
      stored,
    )
    assert.equal(opened.keyVersion, rotationRing.activeVersion, name)
    const refreshed = JSON.parse(opened.plaintext) as Record<string, unknown>
    assert.equal(refreshed.accessToken, 'fresh-token', name)
    assert.equal(refreshed.refreshToken, 'refresh-2', name)
    assert.equal(refreshed.expiresIn, 3600, name)
    assert.ok(typeof refreshed.expiresAt === 'number' && refreshed.expiresAt > Date.now(), name)
  }
})
