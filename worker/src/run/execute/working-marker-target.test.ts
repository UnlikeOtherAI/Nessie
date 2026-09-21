import assert from 'node:assert/strict'
import test from 'node:test'
import { workingMessageIdForTrigger } from './working-marker.js'

test('a hidden policy kickoff marks its original visible source', () => {
  assert.equal(workingMessageIdForTrigger({
    id: 'hidden', role: 'system', metadata: { channelPolicyKickoff: { sourceMessageId: 'human-turn' } },
  }), 'human-turn')
})

test('ordinary messages cannot redirect the working marker through supplied metadata', () => {
  assert.equal(workingMessageIdForTrigger({
    id: 'own-turn', role: 'user', metadata: { channelPolicyKickoff: { sourceMessageId: 'somewhere-else' } },
  }), 'own-turn')
  assert.equal(workingMessageIdForTrigger({ id: 'scheduled', role: 'system', metadata: {} }), 'scheduled')
})
