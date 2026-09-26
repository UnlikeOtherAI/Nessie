import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { OrchestrateDecideJobPayloadSchema } from '../jobs.js'

const decide = (content: string) => ({
  actorContext: {
    actionContext: { effectiveUserId: randomUUID(), purpose: 'message.create', requestId: 'send' },
    actor: { actorId: randomUUID(), actorType: 'user', roles: ['member'] },
    tenant: { organizationId: randomUUID(), teamId: randomUUID() },
  },
  channelAgents: [{ id: randomUUID(), name: 'CTO', role: 'Engineering lead', systemPrompt: null }],
  channelId: randomUUID(),
  content,
  messageId: randomUUID(),
  role: 'user',
  threadId: randomUUID(),
})

// A screenshot sent with no text is stored with empty content. Its decide job
// must still parse, or the worker dead-letters it and the agent never answers.
test('an attachment-only post still reaches the engagement decision', () => {
  assert.equal(OrchestrateDecideJobPayloadSchema.parse(decide('')).content, '')
  assert.equal(OrchestrateDecideJobPayloadSchema.parse(decide('What is wrong here?')).content, 'What is wrong here?')
})
