import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

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
  const prisma = {
    mcpOAuthSecret: {
      create: async ({ data }: { data: { ref: string; ciphertext: string; iv: string; authTag: string } }) => {
        rows.set(data.ref, data)
        return data
      },
      findUnique: async ({ where }: { where: { ref: string } }) => rows.get(where.ref) ?? null,
      update: async ({ where, data }: {
        where: { ref: string }
        data: { ciphertext: string; iv: string; authTag: string }
      }) => {
        state.updates += 1
        const existing = rows.get(where.ref)
        if (!existing) throw new Error('not found')
        rows.set(where.ref, { ...existing, ...data })
        return rows.get(where.ref)
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
