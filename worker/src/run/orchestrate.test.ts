import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolvePersonalAssistantDecisions,
  runActorContextForCandidate,
} from './orchestrate.js'

const personalAssistant = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Personal Assistant',
  role: 'assistant',
  systemPrompt: null,
}

test('a personal-assistant DM always creates a threaded reply decision for a human turn', () => {
  assert.deepEqual(
    resolvePersonalAssistantDecisions('personal_assistant', 'user', [personalAssistant]),
    // Structural, like the @mention fast path: the turn is addressed to this
    // one assistant, so its answer belongs to that exchange.
    [{ action: 'reply', agentId: personalAssistant.id, replyPlacement: 'thread' }],
  )
})

test('a personal-assistant DM does not reply to an assistant-authored turn', () => {
  assert.deepEqual(
    resolvePersonalAssistantDecisions('personal_assistant', 'assistant', [personalAssistant]),
    [],
  )
})

test('shared channels remain on the model-judged engagement path', () => {
  assert.equal(
    resolvePersonalAssistantDecisions(null, 'user', [personalAssistant]),
    null,
  )
})

test('a shared-channel PA run takes the presence owner as its effective user', () => {
  const principalUserId = '00000000-0000-4000-8000-000000000002'
  const context = runActorContextForCandidate(
    {
      actionContext: { requestId: 'pa-presence' },
      actor: {
        actorId: '00000000-0000-4000-8000-000000000003',
        actorType: 'user',
        roles: ['member'],
      },
      tenant: { organizationId: '00000000-0000-4000-8000-000000000004' },
    } as never,
    { ...personalAssistant, principalUserId } as never,
  )

  assert.equal(context.actor.actorId, '00000000-0000-4000-8000-000000000003')
  assert.equal(context.actionContext.effectiveUserId, principalUserId)
})
