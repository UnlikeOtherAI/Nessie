import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient, TaskPriority, TaskStatus } from '@prisma/client'

import { moveTaskToColumn } from '../src/services/tasks.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const taskId = '00000000-0000-4000-8000-000000000003'
const actorId = '00000000-0000-4000-8000-000000000004'
const existingAssigneeId = '00000000-0000-4000-8000-000000000005'
const boardId = '00000000-0000-4000-8000-00000000000a'
const todoColumnId = '00000000-0000-4000-8000-000000000010'
const inProgressColumnId = '00000000-0000-4000-8000-000000000011'

type TaskFixture = {
  id: string
  organizationId: string
  projectId: string | null
  iterationId: string | null
  storyPoints: number | null
  agentId: string | null
  parentTaskId: string | null
  runId: string | null
  status: TaskStatus
  priority: TaskPriority
  dueDate: Date | null
  archivedAt: Date | null
  title: string | null
  purpose: string | null
  detail: string | null
  assigneeUserId: string | null
  assigneeAgentId: string | null
  ownerUserId: string | null
  createdByUserId: string | null
  createdAt: Date
  updatedAt: Date
}

type TaskEventFixture = {
  taskId: string
  eventType: string
  payload: unknown
}

type ColumnFixture = {
  id: string
  category: 'todo' | 'in_progress' | 'review' | 'done'
  position: number
}

type PlacementFixture = { taskId: string; boardId: string; columnId: string; position: number }

const makeTask = (overrides: Partial<TaskFixture> = {}): TaskFixture => ({
  id: taskId,
  organizationId,
  projectId,
  iterationId: null,
  storyPoints: null,
  agentId: null,
  parentTaskId: null,
  runId: null,
  status: 'inbox',
  priority: 'medium',
  dueDate: null,
  archivedAt: null,
  title: 'Write implementation notes',
  purpose: 'Document the behavior',
  detail: null,
  assigneeUserId: null,
  assigneeAgentId: null,
  ownerUserId: null,
  createdByUserId: actorId,
  createdAt: new Date('2026-06-15T08:00:00.000Z'),
  updatedAt: new Date('2026-06-15T08:00:00.000Z'),
  ...overrides,
})

const hydrateTask = (task: TaskFixture) => ({
  ...task,
  assignee: task.assigneeUserId
    ? { displayName: task.assigneeUserId === actorId ? 'Current User' : 'Assigned User' }
    : null,
  assigneeAgent: null,
  owner: null,
})

/**
 * A move now writes a `TaskBoardPlacement` rather than a column id on the task,
 * so the fake models the board, its columns and the placement table — the
 * queries the code makes, not the ones it used to make.
 */
const makePrisma = (task: TaskFixture, columns: ColumnFixture[]) => {
  const events: TaskEventFixture[] = []
  const placements: PlacementFixture[] = []

  const updateTask = (data: Partial<TaskFixture>) => {
    if (data.status !== undefined) task.status = data.status
    if (data.assigneeUserId !== undefined) task.assigneeUserId = data.assigneeUserId
    if (data.assigneeAgentId !== undefined) task.assigneeAgentId = data.assigneeAgentId
  }

  const tx = {
    task: {
      findFirst: async ({ where }: { where: { id: string; organizationId?: string } }) =>
        where.id === task.id &&
        (!where.organizationId || where.organizationId === task.organizationId)
          ? hydrateTask(task)
          : null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === task.id ? hydrateTask(task) : null,
      findMany: async () => [hydrateTask(task)],
      update: async ({ data }: { data: Partial<TaskFixture> }) => {
        updateTask(data)
        return hydrateTask(task)
      },
      updateMany: async ({
        data,
        where,
      }: {
        data: Partial<TaskFixture>
        where: { id: string; organizationId: string; status: TaskStatus }
      }) => {
        if (
          where.id !== task.id ||
          where.organizationId !== task.organizationId ||
          where.status !== task.status
        ) {
          return { count: 0 }
        }
        updateTask(data)
        return { count: 1 }
      },
    },
    taskBoardPlacement: {
      findMany: async () => placements,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { taskId_boardId: { taskId: string; boardId: string } }
        create: PlacementFixture
        update: { columnId: string; position: number }
      }) => {
        const existing = placements.find(
          (placement) =>
            placement.taskId === where.taskId_boardId.taskId &&
            placement.boardId === where.taskId_boardId.boardId,
        )
        if (existing) Object.assign(existing, update)
        else placements.push({ ...create })
        return existing ?? placements[placements.length - 1]
      },
      // The stale-placement sweep: everything on *other* boards whose column
      // no longer matches the task's category.
      deleteMany: async () => ({ count: 0 }),
    },
    taskEvent: {
      create: async ({ data }: { data: TaskEventFixture }) => {
        events.push(data)
        return data
      },
    },
  }

  const prisma = {
    task: tx.task,
    boardColumn: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; board: { projectId: string } }
      }) => {
        const column = columns.find((candidate) => candidate.id === where.id)
        if (!column || where.board.projectId !== task.projectId) return null
        return {
          id: column.id,
          category: column.category,
          board: { id: boardId, columns },
        }
      },
    },
    $transaction: async <T>(callback: (client: typeof tx) => Promise<T>) => callback(tx),
  } as unknown as PrismaClient

  return { events, placements, prisma }
}

const inProgressBoard: ColumnFixture[] = [
  { id: todoColumnId, category: 'todo', position: 0 },
  { id: inProgressColumnId, category: 'in_progress', position: 1 },
]

test('moveTaskToColumn auto-assigns an unassigned task moved into In Progress', async () => {
  const task = makeTask()
  const { events, placements, prisma } = makePrisma(task, inProgressBoard)

  const result = await moveTaskToColumn(prisma, {
    actorId,
    columnId: inProgressColumnId,
    organizationId,
    taskId,
  })

  assert.equal('error' in result, false)
  assert.equal(result.assigneeUserId, actorId)
  assert.equal(result.assigneeAgentId, null)
  assert.equal(result.assigneeName, 'Current User')
  assert.equal(result.status, 'in_progress')
  // The placement is where the column now lives — the task carries no column.
  assert.deepEqual(placements, [
    { taskId, boardId, columnId: inProgressColumnId, position: 0 },
  ])
  assert.deepEqual(
    events.map((event) => event.eventType),
    ['status_changed', 'assigned'],
  )
  assert.deepEqual(events[1]?.payload, {
    by: actorId,
    assigneeUserId: actorId,
    assigneeAgentId: null,
    reason: 'moved_to_in_progress',
  })
})

test('moveTaskToColumn keeps an existing assignee when moved into In Progress', async () => {
  const task = makeTask({ assigneeUserId: existingAssigneeId })
  const { events, prisma } = makePrisma(task, inProgressBoard)

  const result = await moveTaskToColumn(prisma, {
    actorId,
    columnId: inProgressColumnId,
    organizationId,
    taskId,
  })

  assert.equal('error' in result, false)
  assert.equal(result.assigneeUserId, existingAssigneeId)
  assert.equal(result.status, 'in_progress')
  assert.deepEqual(
    events.map((event) => event.eventType),
    ['status_changed'],
  )
})

// The column names its board and the board names its project, so a column id
// the project's boards do not contain is a 404 — never a cross-project move.
// The project scoping itself is proven against a real database in
// `packages/team-admin/test/board-placement.test.ts`; a hand-built fake cannot
// disagree with the `where` the caller passed it.
test('an unknown column id is refused and writes no placement', async () => {
  const task = makeTask()
  const { placements, prisma } = makePrisma(task, inProgressBoard)

  const result = await moveTaskToColumn(prisma, {
    actorId,
    columnId: '00000000-0000-4000-8000-0000000000ff',
    organizationId,
    taskId,
  })

  assert.deepEqual(result, { error: 'COLUMN_NOT_FOUND' })
  assert.deepEqual(placements, [])
})
