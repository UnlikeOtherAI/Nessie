import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DM_QUIET_DAYS,
  isListedPersonDm,
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

/**
 * One fixed "now" for every recency case. The window is a fortnight wide, so a
 * test that let `Date.now()` in would start failing a fortnight after whoever
 * wrote its fixture dates — which is exactly how these cases used to be
 * written, and what the 14-day rule turned into a time bomb.
 */
const NOW = Date.parse('2026-09-16T12:00:00.000Z')
const daysAgo = (days: number): string => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString()

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
  assert.deepEqual(resolvePeopleWithConversations(directory, channels, undefined, NOW), [])
})

test('a colleague appears once their DM holds a message', () => {
  const channels = [
    channel({ id: 'dm-1', dmUserId: 'user-them', lastMessageAt: daysAgo(1) }),
  ]
  const directory = resolvePeopleDirectory(me, [colleague], channels)

  assert.deepEqual(
    resolvePeopleWithConversations(directory, channels, undefined, NOW).map((person) => person.id),
    ['user-them'],
  )
})

test('and drops off once it has been quiet for the whole window', () => {
  const quiet = [channel({ id: 'dm-1', dmUserId: 'user-them', lastMessageAt: daysAgo(15) })]
  const directory = resolvePeopleDirectory(me, [colleague], quiet)
  assert.deepEqual(resolvePeopleWithConversations(directory, quiet, undefined, NOW), [])

  // The way back is a message, not a setting: the same channel, listed again
  // the moment it carries something newer.
  const spokenTo = [{ ...quiet[0]!, lastMessageAt: daysAgo(0) }]
  assert.deepEqual(
    resolvePeopleWithConversations(directory, spokenTo, undefined, NOW).map((person) => person.id),
    ['user-them'],
  )
})

test('the conversation being viewed stays listed before its first message', () => {
  const channels = [channel({ id: 'dm-1', dmUserId: 'user-them' })]
  const directory = resolvePeopleDirectory(me, [colleague], channels)

  assert.deepEqual(
    resolvePeopleWithConversations(directory, channels, 'dm-1', NOW).map((person) => person.id),
    ['user-them'],
  )
})

test('the window is a fortnight, counted from the last message', () => {
  const dm = (days: number): ChannelRecord =>
    channel({ id: 'dm-1', dmUserId: 'user-them', lastMessageAt: daysAgo(days) })

  assert.equal(isListedPersonDm(dm(DM_QUIET_DAYS - 1), { now: NOW }), true)
  // The boundary is the fortnight itself: at exactly 14 days it is out, so the
  // rule reads the way it is written rather than lasting a fifteenth day.
  assert.equal(isListedPersonDm(dm(DM_QUIET_DAYS), { now: NOW }), false)
  assert.equal(isListedPersonDm(dm(DM_QUIET_DAYS + 1), { now: NOW }), false)
})

test('a quiet DM stays while it still holds something unread', () => {
  const unread = channel({
    id: 'dm-1',
    dmUserId: 'user-them',
    lastMessageAt: daysAgo(40),
    unreadCount: 2,
  })
  // Tidying a list must never hide a message nobody has read.
  assert.equal(isListedPersonDm(unread, { now: NOW }), true)
  assert.equal(isListedPersonDm({ ...unread, unreadCount: 0 }, { now: NOW }), false)
})

test('the DM on screen never ages out underneath the reader', () => {
  const stale = channel({ id: 'dm-1', dmUserId: 'user-them', lastMessageAt: daysAgo(90) })
  assert.equal(isListedPersonDm(stale, { currentChannelId: 'dm-1', now: NOW }), true)
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
