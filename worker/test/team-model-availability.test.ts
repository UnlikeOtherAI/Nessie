import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentModelSelectionError } from '@nessie/team-admin'

import { runAgentCreateTool } from '../src/run/pa-tools/provisioning.js'

const teamId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const userId = '33333333-3333-4333-8333-333333333333'

test('agent_create refuses a Ledger pair disabled for the active team', async () => {
  const originalFetch = globalThis.fetch
  const originalPublicUrl = process.env.LEDGER_PUBLIC_URL
  const originalBaseUrl = process.env.NESSIE_MODEL_BASE_URL
  const originalApiKey = process.env.NESSIE_MODEL_API_KEY
  process.env.LEDGER_PUBLIC_URL = 'https://ledger.example'
  process.env.NESSIE_MODEL_BASE_URL = 'https://ledger.example/v1/chat/completions'
  process.env.NESSIE_MODEL_API_KEY = 'lk_test'
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: [{
      id: 'gpt-5-mini',
      kind: 'service',
      service: { id: 'ledger-openai', name: 'OpenAI' },
      endpoints: ['chat/completions'],
    }],
  }), { status: 200 })) as typeof fetch

  const context = {
    actorContext: {
      actionContext: { requestId: 'request-1' },
      actor: { actorId: userId, actorType: 'user' },
      tenant: { organizationId, teamId },
    },
    agentId: '44444444-4444-4444-8444-444444444444',
    agentKind: 'personal_assistant',
    channel: { id: '55555555-5555-4555-8555-555555555555', organizationId, teamId },
    ledgerIdentity: null,
    prisma: {
      inferenceModel: { findMany: async () => [] },
      organizationMember: {
        findUnique: async () => ({ deactivatedAt: null, role: 'owner' }),
      },
      teamInferenceModelAvailability: {
        findMany: async () => [{ model: 'gpt-5-mini', provider: 'ledger-openai' }],
      },
    },
  } as never

  try {
    await assert.rejects(
      runAgentCreateTool(context, {
        model: 'gpt-5-mini',
        name: 'Team-limited helper',
        provider: 'ledger-openai',
      }),
      (error: unknown) =>
        error instanceof AgentModelSelectionError
        && error.code === 'AGENT_MODEL_DISABLED_FOR_TEAM',
    )
  } finally {
    globalThis.fetch = originalFetch
    if (originalPublicUrl === undefined) delete process.env.LEDGER_PUBLIC_URL
    else process.env.LEDGER_PUBLIC_URL = originalPublicUrl
    if (originalBaseUrl === undefined) delete process.env.NESSIE_MODEL_BASE_URL
    else process.env.NESSIE_MODEL_BASE_URL = originalBaseUrl
    if (originalApiKey === undefined) delete process.env.NESSIE_MODEL_API_KEY
    else process.env.NESSIE_MODEL_API_KEY = originalApiKey
  }
})
