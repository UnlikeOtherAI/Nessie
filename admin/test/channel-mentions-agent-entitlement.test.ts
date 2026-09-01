import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentRecord } from '../src/lib/api-client'
import {
  buildAgentMentionEntities,
  buildPersonalAssistantMentionEntities,
} from '../src/pages/channels/useChannelMentions.js'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

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

test('a PA mention picker projects its name but inserts the public structured address', () => {
  const agentId = '00000000-0000-4000-8000-000000000003'
  const principalUserId = '00000000-0000-4000-8000-000000000004'

  assert.deepEqual(
    buildPersonalAssistantMentionEntities([{
      agentId,
      displayName: 'Personal Assistant',
      id: '00000000-0000-4000-8000-000000000005',
      isPersonalAssistant: true,
      mentionName: 'Owner – PA',
      principalUserId,
    }]),
    [{
      id: agentId,
      insertName: 'Owner – PA',
      name: 'Personal Assistant',
      principalUserId,
      trigger: '@',
      type: 'agent',
    }],
  )
})

test('an agent mention opens its direct-message conversation rather than the agent designer', () => {
  const source = readSource('../src/pages/channels/useChannelMentions.tsx')

  assert.match(source, /useNavigateToAgentDm/)
  assert.match(source, /navigateToAgentDm\(entity\.id\)/)
  assert.match(source, /title=\{`Message \$\{entity\.name\}`\}/)
  assert.doesNotMatch(source, /to=\{`\/agents\/designer\/\$\{entity\.id\}`\}/)
})
