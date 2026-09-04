import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentMentionSchema } from '../messaging.js'

test('agent mentions identify ordinary agents without relying on a display name', () => {
  assert.deepEqual(AgentMentionSchema.parse({
    agentId: '00000000-0000-4000-8000-000000000001',
    type: 'agent',
  }), {
    agentId: '00000000-0000-4000-8000-000000000001',
    type: 'agent',
  })
})

test('agent mentions may identify a Personal Assistant presence by owner', () => {
  assert.deepEqual(AgentMentionSchema.parse({
    agentId: '00000000-0000-4000-8000-000000000001',
    principalUserId: '00000000-0000-4000-8000-000000000002',
    type: 'agent',
  }), {
    agentId: '00000000-0000-4000-8000-000000000001',
    principalUserId: '00000000-0000-4000-8000-000000000002',
    type: 'agent',
  })
})
