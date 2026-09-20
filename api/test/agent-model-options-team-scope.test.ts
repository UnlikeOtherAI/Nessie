import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'

import { registerAgentRoutes } from '../src/routes/agents.js'

const actorContext = {
  actionContext: { requestId: 'request-1' },
  actor: { actorId: 'user-1', actorType: 'user' },
  tenant: { organizationId: 'organization-1', teamId: 'team-current' },
}

const ledgerResponse = () => new Response(JSON.stringify({
  data: [{
    id: 'gpt-5-mini',
    kind: 'service',
    service: { id: 'ledger-openai', name: 'OpenAI' },
    endpoints: ['chat/completions'],
  }],
}), { status: 200 })

test('an editing agent id resolves its own team, and a foreign agent is not disclosed', async () => {
  const originalFetch = globalThis.fetch
  const originalLedgerPublicUrl = process.env.LEDGER_PUBLIC_URL
  globalThis.fetch = (async () => ledgerResponse()) as typeof fetch
  process.env.LEDGER_PUBLIC_URL = 'https://ledger.example'
  const seenTeamIds: Array<string | null> = []
  const app = Fastify({ logger: false })
  const prisma = {
    agent: {
      findFirst: async ({ where }: { where: { id: string } }) => {
        if (where.id === '11111111-1111-4111-8111-111111111111') {
          return { id: where.id, teamId: 'team-agent' }
        }
        return null
      },
    },
    inferenceModel: { findMany: async () => [] },
    modelSubscription: { findMany: async () => [] },
    teamInferenceModelAvailability: {
      findMany: async ({ where }: { where: { teamId: string } }) => {
        seenTeamIds.push(where.teamId)
        return []
      },
    },
  }
  registerAgentRoutes(app, {
    config: { model: { apiKey: 'lk_test', baseUrl: 'https://ledger.example/v1/openai' } },
    isAgentAccessibleToActor: async () => true,
    ledgerIdentity: null,
    prisma: prisma as never,
    requireActorContext: () => actorContext as never,
  } as never)

  try {
    const editing = await app.inject({
      method: 'GET',
      url: '/api/agents/models?agentId=11111111-1111-4111-8111-111111111111',
    })
    assert.equal(editing.statusCode, 200)
    assert.deepEqual(seenTeamIds, ['team-agent'])

    const foreign = await app.inject({
      method: 'GET',
      url: '/api/agents/models?agentId=22222222-2222-4222-8222-222222222222',
    })
    assert.equal(foreign.statusCode, 404)
    assert.equal(foreign.json().error.code, 'AGENT_NOT_FOUND')
  } finally {
    await app.close()
    globalThis.fetch = originalFetch
    if (originalLedgerPublicUrl === undefined) delete process.env.LEDGER_PUBLIC_URL
    else process.env.LEDGER_PUBLIC_URL = originalLedgerPublicUrl
  }
})
