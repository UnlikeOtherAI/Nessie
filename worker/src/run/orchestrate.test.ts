import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveSystemDmDecisions,
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
    resolveSystemDmDecisions('personal_assistant', 'user', [personalAssistant]),
    // Structural, like the @mention fast path: the turn is addressed to this
    // one assistant, so its answer belongs to that exchange.
    [{ action: 'reply', agentId: personalAssistant.id, replyPlacement: 'thread' }],
  )
})

test('a personal-assistant DM does not reply to an assistant-authored turn', () => {
  assert.deepEqual(
    resolveSystemDmDecisions('personal_assistant', 'assistant', [personalAssistant]),
    [],
  )
})

test('shared channels remain on the model-judged engagement path', () => {
  assert.equal(
    resolveSystemDmDecisions(null, 'user', [personalAssistant]),
    null,
  )
})

test('a global agent home DM takes the same structural route', () => {
  const designer = { ...personalAssistant, name: 'Agent Designer' }
  assert.deepEqual(
    resolveSystemDmDecisions('system_agent', 'user', [designer]),
    // Keyed on the channel type alone. A global agent's home DM has exactly one
    // member and exactly one binding, both database facts, so there is no
    // engagement judgement to make — in any language, slang or spelling.
    [{ action: 'reply', agentId: designer.id, replyPlacement: 'thread' }],
  )
  assert.deepEqual(resolveSystemDmDecisions('system_agent', 'assistant', [designer]), [])
})

test('other system channels keep the model-judged engagement path', () => {
  // An external-agent DM is driven by its own proxy path, and a hosted mailbox
  // operations room is an ordinary room with many participants.
  assert.equal(resolveSystemDmDecisions('external_agent', 'user', [personalAssistant]), null)
  assert.equal(resolveSystemDmDecisions('agent_email', 'user', [personalAssistant]), null)
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
