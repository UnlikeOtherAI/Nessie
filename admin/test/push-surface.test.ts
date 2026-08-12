import assert from 'node:assert/strict'
import test from 'node:test'

import { getAlertLink } from '../src/facades/alerts/hooks.js'
import { resolvePushSurface } from '../src/lib/push-surface.js'

test('maps only exact push-targetable destinations to a structured surface', () => {
  assert.equal(
    resolvePushSurface('/channels/00000000-0000-4000-8000-000000000001'),
    null,
  )
  assert.deepEqual(resolvePushSurface('/ops/usage'), { kind: 'ops_usage' })
  assert.deepEqual(
    resolvePushSurface('/projects/00000000-0000-4000-8000-000000000004/board'),
    { kind: 'project_board', projectId: '00000000-0000-4000-8000-000000000004' },
  )
  assert.deepEqual(
    resolvePushSurface(
      '/projects/00000000-0000-4000-8000-000000000004/docs',
      '?spaceId=00000000-0000-4000-8000-000000000005',
    ),
    { kind: 'knowledge_space', spaceId: '00000000-0000-4000-8000-000000000005' },
  )
  assert.deepEqual(
    resolvePushSurface('/knowledge-base', '?spaceId=00000000-0000-4000-8000-000000000005'),
    { kind: 'knowledge_space', spaceId: '00000000-0000-4000-8000-000000000005' },
  )
  assert.deepEqual(
    resolvePushSurface(
      '/channels/00000000-0000-4000-8000-000000000001/threads/00000000-0000-4000-8000-000000000002/replies/00000000-0000-4000-8000-000000000003',
    ),
    {
      kind: 'channel',
      channelId: '00000000-0000-4000-8000-000000000001',
      rootMessageId: '00000000-0000-4000-8000-000000000003',
      threadId: '00000000-0000-4000-8000-000000000002',
    },
  )
  assert.equal(resolvePushSurface('/channels'), null)
  assert.equal(resolvePushSurface('/projects/00000000-0000-4000-8000-000000000004/docs'), null)
  assert.equal(resolvePushSurface('/settings/notifications'), null)
})

test('routes each durable attention kind to its owning surface', () => {
  assert.deepEqual(getAlertLink({
    id: '00000000-0000-4000-8000-000000000010',
    kind: 'task_assigned',
    messageId: null,
    threadId: null,
    channelId: null,
    channelLabel: null,
    projectId: '00000000-0000-4000-8000-000000000011',
    taskId: '00000000-0000-4000-8000-000000000012',
    knowledgePageId: null,
    actorUserId: null,
    actorAgentId: null,
    actorDisplayName: 'Ada',
    readAt: null,
    createdAt: '2026-08-12T10:00:00.000Z',
  }), { to: '/projects/00000000-0000-4000-8000-000000000011/board' })
  assert.deepEqual(getAlertLink({
    id: '00000000-0000-4000-8000-000000000013',
    kind: 'knowledge_published',
    messageId: null,
    threadId: null,
    channelId: null,
    channelLabel: null,
    projectId: '00000000-0000-4000-8000-000000000011',
    taskId: null,
    knowledgePageId: '00000000-0000-4000-8000-000000000014',
    actorUserId: null,
    actorAgentId: null,
    actorDisplayName: 'Ada',
    readAt: null,
    createdAt: '2026-08-12T10:00:00.000Z',
  }), { to: '/projects/00000000-0000-4000-8000-000000000011/docs?pageId=00000000-0000-4000-8000-000000000014' })
})
