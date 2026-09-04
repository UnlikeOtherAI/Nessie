import assert from 'node:assert/strict'
import test from 'node:test'

import { getAlertLink } from '../src/facades/alerts/hooks.js'
import {
  resolvePushSurface,
  resolveReportedPushSurface,
} from '../src/lib/push-surface.js'

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
    resolvePushSurface('/knowledge-base/spaces/00000000-0000-4000-8000-000000000005'),
    { kind: 'knowledge_space', spaceId: '00000000-0000-4000-8000-000000000005' },
  )
  // `?spaceId=` is the document deep link's consumed intent, stripped the
  // moment the page opens it; it never says where the person is standing.
  assert.equal(
    resolvePushSurface('/knowledge-base?spaceId=00000000-0000-4000-8000-000000000005'),
    null,
  )
  assert.equal(resolvePushSurface('/knowledge-base/spaces/not-a-space'), null)
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

test('keeps the selected Files, Info, or Runs tab from suppressing its reply URL', () => {
  const route = {
    pathname: '/channels/00000000-0000-4000-8000-000000000001/threads/00000000-0000-4000-8000-000000000002/replies/00000000-0000-4000-8000-000000000003',
    search: '',
  }

  assert.equal(resolveReportedPushSurface({ ...route, surface: null }, route), null)
  assert.equal(resolveReportedPushSurface({ ...route, surface: null }, {
    pathname: '/settings/notifications',
    search: '',
  }), undefined)
})

test('routes each durable attention kind to its owning surface', () => {
  assert.deepEqual(getAlertLink({
    id: '00000000-0000-4000-8000-000000000009',
    kind: 'approval_requested',
    messageId: '00000000-0000-4000-8000-000000000010',
    threadId: '00000000-0000-4000-8000-000000000011',
    channelId: '00000000-0000-4000-8000-000000000012',
    channelLabel: 'Private channel',
    projectId: null,
    taskId: null,
    knowledgePageId: null,
    actorUserId: null,
    actorAgentId: null,
    actorDisplayName: 'Nessie',
    readAt: null,
    createdAt: '2026-08-12T10:00:00.000Z',
  }), { to: '/approvals' })
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
