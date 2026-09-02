import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveAgentDms,
  resolvePeopleDirectory,
  resolvePeopleWithConversations,
} from '../src/layouts/admin-shell/sidebar-dm-lists.js'
import type { AgentRecord, ChannelRecord, MeResponse, UserRecord } from '../src/lib/api-client.js'

const channel = (overrides: Partial<ChannelRecord> & { id: string }): ChannelRecord => ({
  label: 'Conversation',
  type: 'dm',
  visibility: 'private',
  organizationId: 'org-1',
  projectId: 'project-1',
  projectName: 'Project',
  teamId: 'team-1',
  teamName: 'Team',
  defaultThreadId: `thread-${overrides.id}`,
  unreadCount: 0,
  lastMessageAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
} as ChannelRecord)

const agent = (id: string, name: string, channelIds: string[]): AgentRecord =>
  ({ id, name, channelIds } as unknown as AgentRecord)

const me = { user: { id: 'user-me', displayName: 'Me' } } as unknown as MeResponse
const colleague = {
  id: 'user-them',
  displayName: 'Them',
  avatarUrl: null,
  avatarAttachmentId: null,
  channelIds: [],
} as unknown as UserRecord

test('a colleague with no conversation is in the directory but not in Direct messages', () => {
  const channels = [channel({ id: 'dm-1', dmUserId: 'user-them' })]
  const directory = resolvePeopleDirectory(me, [colleague], channels)

  assert.deepEqual(
    directory.map((person) => person.id),
    ['user-me', 'user-them'],
  )
  assert.equal(directory[1]?.dmChannelId, 'dm-1')
  assert.deepEqual(resolvePeopleWithConversations(directory, channels), [])
})

test('a colleague appears once their DM holds a message', () => {
  const channels = [
    channel({ id: 'dm-1', dmUserId: 'user-them', lastMessageAt: '2026-09-02T09:00:00.000Z' }),
  ]
  const directory = resolvePeopleDirectory(me, [colleague], channels)

  assert.deepEqual(
    resolvePeopleWithConversations(directory, channels).map((person) => person.id),
    ['user-them'],
  )
})

test('the conversation being viewed stays listed before its first message', () => {
  const channels = [channel({ id: 'dm-1', dmUserId: 'user-them' })]
  const directory = resolvePeopleDirectory(me, [colleague], channels)

  assert.deepEqual(
    resolvePeopleWithConversations(directory, channels, 'dm-1').map((person) => person.id),
    ['user-them'],
  )
})

test("the Agent Designer's provisioned home DM is not listed until it is used", () => {
  const designerChannel = channel({
    id: 'dm-designer',
    label: 'Agent Designer',
    systemChannelType: 'system_agent',
  })
  const systemAgents = [agent('agent-designer', 'Agent Designer', ['dm-designer'])]
  const input = {
    agents: [],
    channels: [designerChannel],
    pinnedChannelIds: new Set<string>(),
    systemAgents,
  }

  assert.deepEqual(resolveAgentDms(input), [])
  assert.deepEqual(
    resolveAgentDms({
      ...input,
      channels: [{ ...designerChannel, lastMessageAt: '2026-09-02T09:00:00.000Z' }],
    }),
    [{ dmChannelId: 'dm-designer', id: 'agent-designer', agentId: 'agent-designer', label: 'Agent Designer' }],
  )
})

test("an agent's home DM is not listed until it is used", () => {
  const home = channel({ id: 'dm-agent', label: 'Researcher' })
  const agents = [agent('agent-1', 'Researcher', ['dm-agent'])]
  const input = { agents, channels: [home], pinnedChannelIds: new Set<string>(), systemAgents: [] }

  assert.deepEqual(resolveAgentDms(input), [])
  assert.deepEqual(
    resolveAgentDms({ ...input, currentChannelId: 'dm-agent' }),
    [{ dmChannelId: 'dm-agent', id: 'agent-1', agentId: 'agent-1', label: 'Researcher' }],
  )
})
