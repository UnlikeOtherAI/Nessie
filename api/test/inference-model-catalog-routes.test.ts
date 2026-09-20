import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'

import { registerInferenceModelCatalogRoutes } from '../src/routes/inference-model-catalog.js'

const catalogueResponse = () => new Response(JSON.stringify({
  data: [
    {
      id: 'gpt-5-mini',
      kind: 'service',
      service: { id: 'ledger-openai', name: 'OpenAI' },
      endpoints: ['chat/completions'],
    },
    {
      id: 'gpt-5-nano',
      kind: 'service',
      service: { id: 'ledger-openai', name: 'OpenAI' },
      endpoints: ['chat/completions'],
    },
    {
      id: 'claude-haiku',
      kind: 'service',
      service: { id: 'anthropic', name: 'Anthropic' },
      endpoints: ['chat/completions'],
    },
  ],
}), {
  headers: { 'Content-Type': 'application/json' },
  status: 200,
})

const makePrisma = () => {
  const providers = new Map<string, { id: string; providerKey: string }>()
  const providerCreates: Array<Record<string, unknown>> = []
  const modelUpserts: Array<Record<string, unknown>> = []
  let transactionOptions: unknown
  let nextProvider = 1

  const client = {
    agent: { groupBy: async () => [] },
    inferenceModel: {
      findMany: async () => [],
      upsert: async (input: Record<string, unknown>) => {
        modelUpserts.push(input)
      },
    },
    inferenceProvider: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        providerCreates.push(data)
        const provider = { id: `provider-${nextProvider++}`, providerKey: String(data.providerKey) }
        providers.set(provider.providerKey, provider)
        return provider
      },
      findFirst: async ({ where }: { where: { providerKey: string } }) =>
        providers.get(where.providerKey) ?? null,
    },
  }

  return {
    ...client,
    $transaction: async (
      callback: (transaction: unknown) => Promise<unknown>,
      options: unknown,
    ) => {
      transactionOptions = options
      return callback(client)
    },
    modelUpserts,
    providerCreates,
    get transactionOptions() { return transactionOptions },
  }
}

const actorContext = {
  actionContext: { requestId: 'request-1' },
  actor: { actorId: 'owner-1', actorType: 'user' },
  tenant: { organizationId: 'organization-1' },
}

const withCatalogueRoute = async (
  callback: (app: ReturnType<typeof Fastify>, prisma: ReturnType<typeof makePrisma>) => Promise<void>,
): Promise<void> => {
  const originalFetch = globalThis.fetch
  const originalLedgerPublicUrl = process.env.LEDGER_PUBLIC_URL
  globalThis.fetch = (async () => catalogueResponse()) as typeof fetch
  process.env.LEDGER_PUBLIC_URL = 'https://ledger.example'

  const app = Fastify({ logger: false })
  const prisma = makePrisma()
  registerInferenceModelCatalogRoutes(app, {
    config: { apiKey: 'lk_test', baseUrl: 'https://ledger.example/v1/openai' },
    ledgerIdentity: null,
    prisma: prisma as never,
    requireActorContext: () => actorContext as never,
    requireOwner: () => true,
  })

  try {
    await callback(app, prisma)
  } finally {
    await app.close()
    globalThis.fetch = originalFetch
    if (originalLedgerPublicUrl === undefined) delete process.env.LEDGER_PUBLIC_URL
    else process.env.LEDGER_PUBLIC_URL = originalLedgerPublicUrl
  }
}

test('the live catalogue filters provider display names and partial model names before pagination', async () => {
  await withCatalogueRoute(async (app) => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/inference/model-catalog?provider=OPENAI&model=MINI&limit=1',
    })

    assert.equal(response.statusCode, 200)
    const body = response.json() as { data: Array<{ model: string; provider: string }>; meta: { total: number } }
    assert.deepEqual(body.data, [{
      agentCount: 0,
      displayName: 'gpt-5-mini',
      enabled: true,
      hasLocalDecision: false,
      model: 'gpt-5-mini',
      provider: 'ledger-openai',
      providerDisplayName: 'OpenAI',
    }])
    assert.equal(body.meta.total, 1)
  })
})

test('the bulk availability route updates every matching live pair, not one page, in one transaction', async () => {
  await withCatalogueRoute(async (app, prisma) => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/inference/model-catalog/bulk',
      payload: { enabled: false, provider: 'openAI' },
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { data: { enabled: false, updatedCount: 2 } })
    assert.equal(prisma.modelUpserts.length, 2)
    assert.equal(prisma.providerCreates.length, 1)
    assert.deepEqual(prisma.transactionOptions, { maxWait: 5_000, timeout: 60_000 })
    assert.deepEqual(prisma.providerCreates[0], {
      connectorKind: 'compiled',
      createdByActorId: 'owner-1',
      displayName: 'OpenAI',
      enabled: false,
      healthStatus: 'unknown',
      lifecycleStatus: 'draft',
      organizationId: 'organization-1',
      providerKey: 'ledger-openai',
      supportsModelDiscovery: true,
      updatedByActorId: 'owner-1',
    })
  })
})

test('the bulk availability route treats omitted filters as the complete live catalogue', async () => {
  await withCatalogueRoute(async (app, prisma) => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/inference/model-catalog/bulk',
      payload: { enabled: true },
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { data: { enabled: true, updatedCount: 3 } })
    assert.equal(prisma.modelUpserts.length, 3)
    assert.equal(prisma.providerCreates.length, 2)
  })
})
