import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'

import { registerTeamRoutes } from '../src/routes/teams.js'

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
  const decisions = new Map<string, boolean>()
  const upserts: Array<Record<string, unknown>> = []
  let transactionOptions: unknown
  const client = {
    agent: { groupBy: async () => [] },
    inferenceModel: {
      findMany: async () => [
        {
          model: 'claude-haiku',
          provider: { providerKey: 'anthropic' },
        },
      ],
    },
    team: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === 'team-1' ? { id: 'team-1' } : null,
    },
    teamInferenceModelAvailability: {
      findMany: async ({ where }: { where: { enabled?: boolean } }) =>
        [...decisions].flatMap(([key, enabled]) => {
          if (where.enabled !== undefined && where.enabled !== enabled) return []
          const [provider, model] = key.split('\u0000')
          return [{ enabled, model, provider }]
        }),
      upsert: async (input: Record<string, unknown>) => {
        upserts.push(input)
        const where = input.where as {
          teamId_provider_model: { model: string; provider: string; teamId: string }
        }
        const update = input.update as { enabled: boolean }
        decisions.set(
          `${where.teamId_provider_model.provider}\u0000${where.teamId_provider_model.model}`,
          update.enabled,
        )
      },
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
    get transactionOptions() { return transactionOptions },
    upserts,
  }
}

const actorContext = {
  actionContext: { requestId: 'request-1' },
  actor: { actorId: 'admin-1', actorType: 'user' },
  tenant: { organizationId: 'organization-1' },
}

const withTeamCatalogueRoute = async (
  callback: (app: ReturnType<typeof Fastify>, prisma: ReturnType<typeof makePrisma>) => Promise<void>,
): Promise<void> => {
  const originalFetch = globalThis.fetch
  const originalLedgerPublicUrl = process.env.LEDGER_PUBLIC_URL
  globalThis.fetch = (async () => catalogueResponse()) as typeof fetch
  process.env.LEDGER_PUBLIC_URL = 'https://ledger.example'

  const app = Fastify({ logger: false })
  const prisma = makePrisma()
  registerTeamRoutes(app, {
    config: { model: { apiKey: 'lk_test', baseUrl: 'https://ledger.example/v1/openai' } },
    ledgerIdentity: null,
    prisma: prisma as never,
    requireActorContext: () => actorContext as never,
    requireOrgAdmin: () => true,
    requireOwner: () => true,
  } as never)

  try {
    await callback(app, prisma)
  } finally {
    await app.close()
    globalThis.fetch = originalFetch
    if (originalLedgerPublicUrl === undefined) delete process.env.LEDGER_PUBLIC_URL
    else process.env.LEDGER_PUBLIC_URL = originalLedgerPublicUrl
  }
}

test('team catalogue filters the live rows after removing organisation-disabled pairs', async () => {
  await withTeamCatalogueRoute(async (app) => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/teams/team-1/inference/model-catalog?provider=openai&model=mini',
    })

    assert.equal(response.statusCode, 200)
    const body = response.json() as { data: Array<{ model: string }>; meta: { total: number } }
    assert.deepEqual(body.data.map((row) => row.model), ['gpt-5-mini'])
    assert.equal(body.meta.total, 1)
  })
})

test('team bulk writes every organisation-allowed live pair in one bounded transaction', async () => {
  await withTeamCatalogueRoute(async (app, prisma) => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/teams/team-1/inference/model-catalog/bulk',
      payload: { enabled: false },
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { data: { enabled: false, updatedCount: 2 } })
    assert.equal(prisma.upserts.length, 2)
    assert.deepEqual(prisma.transactionOptions, { maxWait: 5_000, timeout: 60_000 })
  })
})

test('a team cannot see or re-enable a pair its organisation disabled', async () => {
  await withTeamCatalogueRoute(async (app) => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/teams/team-1/inference/model-catalog',
      payload: { enabled: true, model: 'claude-haiku', provider: 'anthropic' },
    })

    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error.code, 'TEAM_MODEL_DISABLED_BY_ORGANIZATION')
  })
})

test('a team id outside the active organisation is not disclosed', async () => {
  await withTeamCatalogueRoute(async (app) => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/teams/team-other/inference/model-catalog',
    })

    assert.equal(response.statusCode, 404)
    assert.equal(response.json().error.code, 'TEAM_MODEL_CATALOG_TEAM_NOT_FOUND')
  })
})
