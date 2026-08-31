import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentRecord } from '../src/lib/api-client'
import { buildAgentMentionEntities } from '../src/pages/channels/useChannelMentions.js'

const agent = (id: string, name: string, visibility: 'private' | 'workspace'): AgentRecord => ({
  channelIds: [],
  createdAt: '2026-08-31T00:00:00.000Z',
  id,
  lastActivityAt: '2026-08-31T00:00:00.000Z',
  name,
  role: 'assistant',
  status: 'idle',
  updatedAt: '2026-08-31T00:00:00.000Z',
  visibility,
}) as AgentRecord

test('agent mentions trust the server-entitled list without a client visibility filter', () => {
  const workspaceAgent = agent('00000000-0000-4000-8000-000000000001', 'Workspace', 'workspace')
  const privateAgent = agent('00000000-0000-4000-8000-000000000002', 'Private', 'private')

  assert.deepEqual(
    buildAgentMentionEntities([workspaceAgent, privateAgent]).map((entity) => entity.id),
    [workspaceAgent.id, privateAgent.id],
    'the owner-provided, server-entitled private agent stays mentionable',
  )
  assert.deepEqual(
    buildAgentMentionEntities([workspaceAgent]).map((entity) => entity.id),
    [workspaceAgent.id],
    'a non-owner never receives a private agent to mention',
  )
})
