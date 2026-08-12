import assert from 'node:assert/strict'
import test from 'node:test'

import { handleAttentionDispatch } from '../src/control/attention-dispatch.js'

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001'
const USER_ID = '00000000-0000-4000-8000-000000000002'
const ACTOR_ID = '00000000-0000-4000-8000-000000000003'
const PROJECT_ID = '00000000-0000-4000-8000-000000000004'
const TASK_ID = '00000000-0000-4000-8000-000000000005'
const ALERT_ID = '00000000-0000-4000-8000-000000000006'

test('assigned-work attention stays private when no push provider is configured', async () => {
  const prisma = {
    organizationMember: {
      findFirst: async () => ({ id: 'member-1' }),
    },
    projectMember: {
      findFirst: async () => ({ id: 'project-member-1' }),
    },
    pushCredential: {
      findMany: async () => [],
    },
    userAlert: {
      count: async () => 1,
      findFirst: async () => ({
        actorUser: { displayName: 'Ada' },
        createdAt: new Date('2026-08-12T10:00:00.000Z'),
        id: ALERT_ID,
        kind: 'task_assigned',
        knowledgePageId: null,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        user: { preferences: {} },
        userId: USER_ID,
        task: {
          archivedAt: null,
          assigneeUserId: USER_ID,
          id: TASK_ID,
          status: 'assigned',
          title: 'Review the release',
        },
      }),
    },
  }

  const result = await handleAttentionDispatch({
    authSecret: 'test-secret',
    prisma: prisma as never,
  }, { alertId: ALERT_ID })

  assert.deepEqual(result, { failed: 0, pruned: 0, sent: 0 })
})

test('assigned-work attention with no current project membership is not delivered', async () => {
  const prisma = {
    organizationMember: { findFirst: async () => ({ id: 'member-1' }) },
    projectMember: { findFirst: async () => null },
    pushCredential: { findMany: async () => [] },
    userAlert: {
      count: async () => 1,
      findFirst: async () => ({
        actorUser: { displayName: 'Ada' },
        createdAt: new Date('2026-08-12T10:00:00.000Z'),
        id: ALERT_ID,
        kind: 'task_assigned',
        knowledgePageId: null,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        user: { preferences: {} },
        userId: USER_ID,
        task: { archivedAt: null, assigneeUserId: USER_ID, id: TASK_ID, status: 'assigned', title: 'Private task' },
      }),
    },
  }

  const result = await handleAttentionDispatch({
    authSecret: 'test-secret',
    prisma: prisma as never,
  }, { alertId: ALERT_ID })

  assert.deepEqual(result, { failed: 0, pruned: 0, sent: 0 })
})
