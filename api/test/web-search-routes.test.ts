import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import Fastify from 'fastify'

import { registerWebSearchRoutes } from '../src/routes/web-search.js'
import type { RouteDeps } from '../src/routes/types.js'

/**
 * `POST /api/web-search` is the only door a person searches the web through,
 * so what these tests pin is who the search is signed as and what happens on a
 * deployment that has no Ledger: a card's pager must never turn into an
 * unattributed call or a silent 500.
 */

const organizationId = '00000000-0000-4000-8000-000000000001'
const teamId = '00000000-0000-4000-8000-000000000002'
const userId = '00000000-0000-4000-8000-000000000003'

const SERPER_BODY = {
  organic: [
    { title: 'First', link: 'https://example.com/one', snippet: 'A snippet.' },
  ],
}

const buildApp = async (options: { configured?: boolean } = {}) => {
  const signed: Array<Record<string, unknown>> = []
  const requests: Array<{ url: string; body: unknown }> = []
  const prisma = {
    budget: { findMany: async () => [] },
  } as unknown as PrismaClient

  const app = Fastify()
  registerWebSearchRoutes(app, {
    prisma,
    ledgerIdentity: options.configured === false
      ? null
      : {
        requestHeaders: async (attribution: Record<string, unknown>) => {
          signed.push(attribution)
          return { 'X-Nessie-Context': 'signed-nessie-context' }
        },
      },
    requireActorContext: () => ({
      actionContext: { requestId: 'request-1' },
      actor: { actorId: userId, actorType: 'user', roles: ['member'] },
      tenant: { organizationId, teamId },
    }),
  } as unknown as RouteDeps)
  await app.ready()

  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify(SERPER_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  return {
    app,
    requests,
    signed,
    close: async () => {
      globalThis.fetch = realFetch
      await app.close()
    },
  }
}

const withLedgerEnv = <T>(work: () => Promise<T>): Promise<T> => {
  const previous = { ...process.env }
  process.env.LEDGER_PUBLIC_URL = 'https://ledger.example'
  process.env.LEDGER_PROXY_TOKEN = 'lk_nessie_test'
  return work().finally(() => {
    process.env = previous
  })
}

test('a page is fetched through Ledger and answered as a card', async () => {
  await withLedgerEnv(async () => {
    const harness = await buildApp()
    try {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/web-search',
        payload: { query: 'loch ness', page: 3, count: 5 },
      })

      assert.equal(response.statusCode, 200, response.body)
      const card = JSON.parse(response.body)
      assert.equal(card.schemaVersion, 1)
      assert.equal(card.page, 3)
      assert.equal(card.provider, 'serper')
      assert.equal(card.results[0].url, 'https://example.com/one')

      assert.deepEqual(harness.requests, [{
        url: 'https://ledger.example/v1/serper/search',
        body: { q: 'loch ness', num: 5, page: 3 },
      }])
      // The person who clicked is who the search is signed as — not the agent
      // that posted the card, which is not running any more.
      assert.equal(harness.signed[0]?.userId, userId)
      assert.equal(harness.signed[0]?.organizationId, organizationId)
      assert.equal(harness.signed[0]?.systemComponent, 'web-search')
    } finally {
      await harness.close()
    }
  })
})

test('a deployment with no Ledger says so instead of failing obscurely', async () => {
  await withLedgerEnv(async () => {
    const harness = await buildApp({ configured: false })
    try {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/web-search',
        payload: { query: 'loch ness' },
      })

      assert.equal(response.statusCode, 503)
      assert.equal(JSON.parse(response.body).error.code, 'WEB_SEARCH_UNCONFIGURED')
      assert.equal(harness.requests.length, 0)
    } finally {
      await harness.close()
    }
  })
})

test('an empty query is refused before anything is spent', async () => {
  await withLedgerEnv(async () => {
    const harness = await buildApp()
    try {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/web-search',
        payload: { query: '   ' },
      })

      assert.equal(response.statusCode, 400)
      assert.equal(harness.requests.length, 0)
    } finally {
      await harness.close()
    }
  })
})
