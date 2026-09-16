import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type DashboardChannel,
  type DashboardTask,
  type QueueTask,
  backlogTaskCount,
  formatRelativeAge,
  projectChannelRows,
  projectWorkQueue,
  scopeTasksToBoard,
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

const queued = (overrides: Partial<QueueTask> & { id?: string }): QueueTask & { id: string } => ({
  id: overrides.id ?? 't',
  status: 'in_progress',
  priority: 'medium',
  dueDate: null,
  archivedAt: null,
  iterationId: null,
  assigneeUserId: null,
  title: null,
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
})

test('the work queue shows the reader’s own open tickets, latest first', () => {
  const queue = projectWorkQueue(
    [
      queued({ id: 'old-mine', assigneeUserId: 'me', updatedAt: '2026-08-01T00:00:00.000Z' }),
      queued({ id: 'new-mine', assigneeUserId: 'me', updatedAt: '2026-08-09T00:00:00.000Z' }),
      queued({ id: 'theirs', assigneeUserId: 'other', updatedAt: '2026-08-10T00:00:00.000Z' }),
      queued({ id: 'unclaimed', status: 'inbox', updatedAt: '2026-08-11T00:00:00.000Z' }),
    ],
    { userId: 'me' },
  )

  assert.equal(queue.focus, 'mine')
  assert.deepEqual(queue.tasks.map((t) => t.id), ['new-mine', 'old-mine'])
  assert.equal(queue.matched, 2)
})

test('with nothing of their own it falls back to what nobody has picked up', () => {
  const queue = projectWorkQueue(
    [
      queued({ id: 'theirs', assigneeUserId: 'other' }),
      queued({ id: 'unclaimed', status: 'inbox', updatedAt: '2026-08-05T00:00:00.000Z' }),
      queued({ id: 'older-unclaimed', status: 'inbox', updatedAt: '2026-08-02T00:00:00.000Z' }),
    ],
    { userId: 'me' },
  )

  assert.equal(queue.focus, 'todo')
  assert.deepEqual(queue.tasks.map((t) => t.id), ['unclaimed', 'older-unclaimed'])
})

test('with nothing unclaimed either it shows everything still open', () => {
  // A blank column while the project has work in flight reads as "no work
  // here", which is the one thing this page must not say wrongly.
  const queue = projectWorkQueue(
    [queued({ id: 'theirs', assigneeUserId: 'other' }), queued({ id: 'review', status: 'review' })],
    { userId: 'me' },
  )

  assert.equal(queue.focus, 'open')
  assert.equal(queue.matched, 2)
})

test('the work queue never offers finished or archived work', () => {
  const queue = projectWorkQueue(
    [
      queued({ id: 'done', assigneeUserId: 'me', status: 'done' }),
      queued({ id: 'cancelled', assigneeUserId: 'me', status: 'cancelled' }),
      queued({ id: 'archived', assigneeUserId: 'me', archivedAt: '2026-01-01T00:00:00.000Z' }),
      queued({ id: 'live', assigneeUserId: 'me' }),
    ],
    { userId: 'me' },
  )

  assert.deepEqual(queue.tasks.map((t) => t.id), ['live'])
})

test('a signed-out reader has no tickets of their own, so the fallback applies', () => {
  const queue = projectWorkQueue([queued({ id: 'a', assigneeUserId: 'me' })], { userId: undefined })
  assert.equal(queue.focus, 'open')
})

test('the cap is honoured and the remainder is reported', () => {
  const many = Array.from({ length: 12 }, (_, index) =>
    queued({
      id: `t${index}`,
      assigneeUserId: 'me',
      updatedAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    }))

  const queue = projectWorkQueue(many, { limit: 8, userId: 'me' })
  assert.equal(queue.tasks.length, 8)
  assert.equal(queue.matched, 12)
  assert.equal(queue.tasks[0]?.id, 't11')
})

test('the backlog count is open work in no sprint', () => {
  assert.equal(
    backlogTaskCount([
      task({ iterationId: 'it-1' }),
      task({ iterationId: null }),
      task({ iterationId: null, status: 'done' }),
      task({ iterationId: null, archivedAt: '2026-01-01T00:00:00.000Z' }),
    ]),
    1,
  )
})
