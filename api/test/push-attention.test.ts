import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createKnowledgePublicationAttention,
  createTaskAssignmentAttention,
} from '../src/services/push-attention.js'

type AlertRow = {
  eventKey: string
  id: string
  kind: 'knowledge_published' | 'task_assigned'
  knowledgePageId?: string
  organizationId: string
  readAt: Date | null
  taskId?: string
  userId: string
}

const ORG_ID = '00000000-0000-4000-8000-000000000001'
const PROJECT_ID = '00000000-0000-4000-8000-000000000002'
const TASK_ID = '00000000-0000-4000-8000-000000000003'
const PAGE_ID = '00000000-0000-4000-8000-000000000004'
const SPACE_ID = '00000000-0000-4000-8000-000000000005'
const ACTOR_ID = '00000000-0000-4000-8000-000000000006'
const RECIPIENT_ID = '00000000-0000-4000-8000-000000000007'
const OTHER_RECIPIENT_ID = '00000000-0000-4000-8000-000000000011'
const AGENT_ID = '00000000-0000-4000-8000-000000000012'

const makeTransaction = (
  rows: AlertRow[],
  options: {
    agentAudience?: unknown
    memberUserIds?: string[]
    ownerAgentId?: string | null
  } = {},
) => {
  const agentVisibilityQueries: unknown[] = []
  return {
    agent: {
      findFirst: async (args: unknown) => {
        agentVisibilityQueries.push(args)
        return options.agentAudience ?? null
      },
    },
    $executeRaw: async () => 1,
    knowledgeSpace: {
      findFirst: async () => ({
        channelId: null,
        createdBy: ACTOR_ID,
        id: SPACE_ID,
        members: [],
        ownerAgentId: options.ownerAgentId ?? null,
        privateToAgentId: null,
        projectId: PROJECT_ID,
        sensitivityTier: 'normal',
        teamId: null,
        visibility: 'organization',
        writeRestricted: false,
      }),
    },
    organizationMember: {
      findFirst: async () => ({ id: 'org-member' }),
      findMany: async () => (options.memberUserIds ?? [RECIPIENT_ID]).map((userId) => ({ userId })),
    },
    projectMember: {
      findFirst: async () => ({ id: 'project-member' }),
      findMany: async () => [{ userId: RECIPIENT_ID }],
    },
    userAlert: {
      updateMany: async ({ where }: { where: {
        kind: AlertRow['kind']
        knowledgePageId?: string
        organizationId: string
        OR: { eventKey: { not: string } | null }[]
        readAt: null
        taskId?: string
      } }) => {
        const currentEventKey = where.OR[0]!.eventKey && 'not' in where.OR[0]!.eventKey
          ? where.OR[0]!.eventKey.not
          : null
        let count = 0
        for (const row of rows) {
          if (row.kind !== where.kind || row.organizationId !== where.organizationId || row.readAt !== null) {
            continue
          }
          if (where.taskId && row.taskId !== where.taskId) continue
          if (where.knowledgePageId && row.knowledgePageId !== where.knowledgePageId) continue
          if (row.eventKey === currentEventKey) continue
          row.readAt = new Date()
          count += 1
        }
        return { count }
      },
      upsert: async ({ create, where }: { create: Omit<AlertRow, 'id' | 'readAt'>; where: { userId_eventKey: { eventKey: string; userId: string } } }) => {
        const existing = rows.find((row) =>
          row.eventKey === where.userId_eventKey.eventKey && row.userId === where.userId_eventKey.userId,
        )
        if (existing) return { id: existing.id }
        const row: AlertRow = { ...create, id: `alert-${rows.length + 1}`, readAt: null }
        rows.push(row)
        return { id: row.id }
      },
    },
    agentVisibilityQueries,
  }
}

test('a newer task assignment retires an older unread generation without retiring its retry', async () => {
  const rows: AlertRow[] = []
  const tx = makeTransaction(rows)
  const input = {
    actorUserId: ACTOR_ID,
    assigneeUserId: RECIPIENT_ID,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
  }

  await createTaskAssignmentAttention(tx as never, { ...input, eventKey: 'task-event-1' })
  await createTaskAssignmentAttention(tx as never, { ...input, eventKey: 'task-event-1' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.readAt, null)

  await createTaskAssignmentAttention(tx as never, { ...input, eventKey: 'task-event-2' })
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0]?.readAt, null)
  assert.equal(rows[1]?.readAt, null)
})

test('an assignment with no notification target still retires the previous task attention', async () => {
  const rows: AlertRow[] = [{
    eventKey: 'task-event-1',
    id: 'alert-1',
    kind: 'task_assigned',
    organizationId: ORG_ID,
    readAt: null,
    taskId: TASK_ID,
    userId: RECIPIENT_ID,
  }]

  await createTaskAssignmentAttention(makeTransaction(rows) as never, {
    actorUserId: RECIPIENT_ID,
    assigneeUserId: RECIPIENT_ID,
    eventKey: 'task-event-2',
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
  })

  assert.notEqual(rows[0]?.readAt, null)
})

test('ordinary publications make no agent visibility query', async () => {
  const rows: AlertRow[] = []
  const input = {
    actorUserId: ACTOR_ID,
    organizationId: ORG_ID,
    pageId: PAGE_ID,
    projectId: PROJECT_ID,
    spaceId: SPACE_ID,
  }

  const tx = makeTransaction(rows)
  await createKnowledgePublicationAttention(tx as never, {
    ...input,
    versionId: '00000000-0000-4000-8000-000000000008',
  })
  await createKnowledgePublicationAttention(tx as never, {
    ...input,
    versionId: '00000000-0000-4000-8000-000000000009',
  })

  assert.equal(rows.length, 2)
  assert.notEqual(rows[0]?.readAt, null)
  assert.equal(rows[1]?.readAt, null)
  assert.deepEqual(tx.agentVisibilityQueries, [])
})

test('an agent-owned publication resolves its audience once for every active recipient set', async () => {
  const rows: AlertRow[] = []
  const tx = makeTransaction(rows, {
    agentAudience: {
      bindings: [],
      ownerMembership: { deactivatedAt: null },
      ownerUserId: RECIPIENT_ID,
      parentAgentId: null,
    },
    memberUserIds: [RECIPIENT_ID, OTHER_RECIPIENT_ID],
    ownerAgentId: AGENT_ID,
  })

  await createKnowledgePublicationAttention(tx as never, {
    actorUserId: ACTOR_ID,
    organizationId: ORG_ID,
    pageId: PAGE_ID,
    projectId: PROJECT_ID,
    spaceId: SPACE_ID,
    versionId: '00000000-0000-4000-8000-000000000008',
  })

  assert.equal(tx.agentVisibilityQueries.length, 1)
  assert.deepEqual(rows.map((row) => row.userId), [RECIPIENT_ID])
})
