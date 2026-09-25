import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import type { ModelConfig } from '@nessie/config'
import { parseOrganizationId, parseTeamId, type AuthorizedActionContext } from '@nessie/schemas'
import { runInferenceGraph } from './inference.js'

const organizationId = '11111111-1111-4111-8111-111111111111'
const actorContext: AuthorizedActionContext = {
  actor: { actorId: '33333333-3333-4333-8333-333333333333', actorType: 'user', roles: ['member'] },
  actionContext: { requestId: 'utility-mode' },
  tenant: { organizationId: parseOrganizationId(organizationId),
    teamId: parseTeamId('22222222-2222-4222-8222-222222222222') },
}

test('a cloud utility call requests non-streaming inference and returns its JSON', async () => {
  const originalFetch = globalThis.fetch
  let request: Record<string, unknown> | undefined
  globalThis.fetch = (async (_url, init) => {
    request = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '{"needsFollowUp":false,"reason":"Done"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }))
  }) as typeof fetch
  try {
    const result = await runInferenceGraph({ $queryRaw: async () => [] } as unknown as PrismaClient, {
      actorContext, organizationId, stream: false,
      agent: { id: '44444444-4444-4444-8444-444444444444', model: 'model', provider: 'openai', routingProfileId: null },
      baseMessages: [{ role: 'user', content: 'Return the completion decision as JSON.' }],
      modelConfig: { apiKey: 'test', backends: [], baseUrl: 'https://provider.example/v1',
        modelName: 'model', provider: 'openai', temperature: 0.2 } as ModelConfig,
    })
    assert.equal(result.status, 'completed')
    assert.deepEqual(JSON.parse(result.finalAnswer!), { needsFollowUp: false, reason: 'Done' })
    assert.notEqual(request?.stream, true)
    assert.equal(request?.reasoning_effort, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})
