import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentRecord } from '../src/lib/api-client'
import { privateAgentHomeChannelId } from '../src/components/features/agents/PrivateAgentHomeLink.js'

const agent = (overrides: Partial<AgentRecord>): AgentRecord => ({
  channelIds: [],
  createdAt: '2026-08-31T00:00:00.000Z',
  id: '00000000-0000-4000-8000-000000000001',
  lastActivityAt: '2026-08-31T00:00:00.000Z',
  name: 'Private researcher',
  role: 'researcher',
  status: 'idle',
  updatedAt: '2026-08-31T00:00:00.000Z',
  visibility: 'workspace',
  ...overrides,
}) as AgentRecord

test('a private agent doorway uses its provisioned home DM', () => {
  assert.equal(
    privateAgentHomeChannelId(agent({
      homeChannelId: '00000000-0000-4000-8000-000000000002',
      visibility: 'private',
    })),
    '00000000-0000-4000-8000-000000000002',
  )
})

test('the list binding remains the private-home doorway after a refresh', () => {
  assert.equal(
    privateAgentHomeChannelId(agent({
      channelIds: ['00000000-0000-4000-8000-000000000003'],
      visibility: 'private',
    })),
    '00000000-0000-4000-8000-000000000003',
  )
})

test('workspace agents have no private-home doorway', () => {
  assert.equal(
    privateAgentHomeChannelId(agent({
      channelIds: ['00000000-0000-4000-8000-000000000004'],
    })),
    undefined,
  )
})
