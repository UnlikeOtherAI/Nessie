import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type DashboardAgent,
  type DashboardChannel,
  type DashboardTask,
  canManageProjectMembers,
  formatRelativeAge,
  orderProjectMembers,
  projectAgentRows,
  projectChannelRows,
  scopeTasksToBoard,
  showsChannelTeamName,
  summarizeWork,
} from '../src/components/features/projects/project-dashboard-data.js'

const channel = (overrides: Partial<DashboardChannel> & { id: string }): DashboardChannel => ({
  label: overrides.id,
  type: 'standard',
  visibility: 'public',
  projectId: 'p1',
  teamName: 'Core',
  unreadCount: 0,
  ...overrides,
})

const task = (overrides: Partial<DashboardTask>): DashboardTask => ({
  status: 'in_progress',
  priority: 'medium',
  dueDate: null,
  archivedAt: null,
  iterationId: null,
  ...overrides,
})

test('channel rows exclude other projects, archived, system and DM channels', () => {
  const rows = projectChannelRows(
    [
      channel({ id: 'keep' }),
      channel({ id: 'other-project', projectId: 'p2' }),
      channel({ id: 'archived', archivedAt: '2026-01-01T00:00:00.000Z' }),
      channel({ id: 'system', systemChannelType: 'announcements' }),
      channel({ id: 'dm', type: 'dm' }),
    ],
    'p1',
  )

  assert.deepEqual(rows.map((row) => row.id), ['keep'])
})

test('channel rows put unread first, then recency, then alphabetical', () => {
  const rows = projectChannelRows(
    [
      channel({ id: 'quiet-b', label: 'quiet-b' }),
      channel({ id: 'quiet-a', label: 'quiet-a' }),
      channel({ id: 'fresh', label: 'fresh', lastMessageAt: '2026-08-11T10:00:00.000Z' }),
      channel({ id: 'one-unread', label: 'one-unread', unreadCount: 1 }),
      channel({ id: 'many-unread', label: 'many-unread', unreadCount: 9 }),
    ],
    'p1',
  )

  assert.deepEqual(
    rows.map((row) => row.id),
    ['many-unread', 'one-unread', 'fresh', 'quiet-a', 'quiet-b'],
  )
})

test('channel rows fall back to alphabetical when lastMessageAt is absent', () => {
  const rows = projectChannelRows(
    [channel({ id: 'c', label: 'charlie' }), channel({ id: 'a', label: 'alpha' })],
    'p1',
  )

  assert.deepEqual(rows.map((row) => row.label), ['alpha', 'charlie'])
})

test('team names are only shown when the project spans more than one team', () => {
  assert.equal(showsChannelTeamName([channel({ id: 'a' }), channel({ id: 'b' })]), false)
  assert.equal(
    showsChannelTeamName([channel({ id: 'a' }), channel({ id: 'b', teamName: 'Design' })]),
    true,
  )
})

test('relative age is coarse and never negative', () => {
  const now = Date.parse('2026-08-11T12:00:00.000Z')
  assert.equal(formatRelativeAge('2026-08-11T11:30:00.000Z', now), 'now')
  assert.equal(formatRelativeAge('2026-08-11T08:00:00.000Z', now), '4h')
  assert.equal(formatRelativeAge('2026-08-08T12:00:00.000Z', now), '3d')
  assert.equal(formatRelativeAge('2026-07-11T12:00:00.000Z', now), '4w')
  assert.equal(formatRelativeAge('2026-08-11T13:00:00.000Z', now), 'now')
  assert.equal(formatRelativeAge(null, now), null)
  assert.equal(formatRelativeAge('not-a-date', now), null)
})

test('work counts only open work, and counts every exception on it', () => {
  const now = Date.parse('2026-08-11T12:00:00.000Z')
  const counts = summarizeWork(
    [
      task({ status: 'done', dueDate: '2020-01-01T00:00:00.000Z', priority: 'urgent' }),
      task({ status: 'cancelled', priority: 'urgent' }),
      task({ archivedAt: '2026-01-01T00:00:00.000Z', priority: 'urgent' }),
      task({ status: 'in_progress', dueDate: '2026-08-10T00:00:00.000Z' }),
      task({ status: 'failed', priority: 'urgent' }),
      task({ status: 'awaiting_approval' }),
      task({ status: 'inbox', dueDate: '2026-12-01T00:00:00.000Z' }),
    ],
    now,
  )

  assert.deepEqual(counts, { open: 4, overdue: 1, urgent: 1, failed: 1, awaitingApproval: 1 })
})

test('scrum work counts are scoped to the active sprint, like the board', () => {
  const tasks = [task({ iterationId: 'it-1' }), task({ iterationId: 'it-2' }), task({})]

  assert.equal(
    scopeTasksToBoard(tasks, { activeIterationId: 'it-1', isScrum: true }).length,
    1,
  )
  assert.equal(scopeTasksToBoard(tasks, { activeIterationId: null, isScrum: false }).length, 3)
})

test('members order by project role rank then name', () => {
  const ordered = orderProjectMembers([
    { userId: '1', displayName: 'Zoe', email: 'z@x', role: 'member' },
    { userId: '2', displayName: 'Ada', email: 'a@x', role: 'viewer' },
    { userId: '3', displayName: 'Bob', email: 'b@x', role: 'owner' },
    { userId: '4', displayName: 'Ann', email: 'an@x', role: 'member' },
  ])

  assert.deepEqual(ordered.map((member) => member.displayName), ['Bob', 'Ann', 'Zoe', 'Ada'])
})

test('project admins manage members without being organisation owners', () => {
  const members = [
    { userId: 'u1', displayName: 'Ada', email: 'a@x', role: 'admin' },
    { userId: 'u2', displayName: 'Bob', email: 'b@x', role: 'member' },
  ]

  assert.equal(
    canManageProjectMembers({ isOrganizationOwner: false, members, userId: 'u1' }),
    true,
  )
  assert.equal(
    canManageProjectMembers({ isOrganizationOwner: false, members, userId: 'u2' }),
    false,
  )
  // An organisation owner who is not a member of the project has no row here.
  assert.equal(
    canManageProjectMembers({ isOrganizationOwner: true, members, userId: 'u3' }),
    true,
  )
})

test('project agents are those bound to project channels, most urgent first', () => {
  const channels = [channel({ id: 'c1' }), channel({ id: 'c2' })]
  const agents: DashboardAgent[] = [
    { id: 'a1', name: 'Idle One', role: 'r', status: 'idle', channelIds: ['c2'] },
    { id: 'a2', name: 'Broken', role: 'r', status: 'error', channelIds: ['c1'] },
    { id: 'a3', name: 'Elsewhere', role: 'r', status: 'error', channelIds: ['other'] },
    {
      id: 'a4',
      agentKind: 'personal_assistant',
      name: 'PA',
      role: 'r',
      status: 'error',
      channelIds: ['c1'],
    },
    { id: 'a5', name: 'Waiting', role: 'r', status: 'waiting_approval', channelIds: ['c2'] },
  ]

  const rows = projectAgentRows(agents, channels)

  assert.deepEqual(rows.map((row) => row.agent.id), ['a2', 'a5', 'a1'])
  assert.equal(rows[0]?.channelId, 'c1')
  assert.equal(rows[1]?.channelId, 'c2')
})
