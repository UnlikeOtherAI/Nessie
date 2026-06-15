import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient, TaskPriority, TaskStatus } from '@prisma/client'

import { moveTaskToColumn } from '../src/services/tasks.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const taskId = '00000000-0000-4000-8000-000000000003'
const actorId = '00000000-0000-4000-8000-000000000004'
const existingAssigneeId = '00000000-0000-4000-8000-000000000005'
const todoColumnId = '00000000-0000-4000-8000-000000000010'
const inProgressColumnId = '00000000-0000-4000-8000-000000000011'

type TaskFixture = {
  id: string
  organizationId: string
  projectId: string | null
  columnId: string | null
  position: number
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
  projectId: string
  category: 'todo' | 'in_progress' | 'review' | 'done'
}

const makeTask = (overrides: Partial<TaskFixture> = {}): TaskFixture => ({
  id: taskId,
  organizationId,
  projectId,
  columnId: todoColumnId,
  position: 0,
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

const makePrisma = (task: TaskFixture, columns: ColumnFixture[]) => {
  const events: TaskEventFixture[] = []

  const updateTask = (data: Partial<TaskFixture>) => {
    if (data.columnId !== undefined) task.columnId = data.columnId
    if (data.status !== undefined) task.status = data.status
    if (data.assigneeUserId !== undefined) task.assigneeUserId = data.assigneeUserId
    if (data.assigneeAgentId !== undefined) task.assigneeAgentId = data.assigneeAgentId
  }

  const tx = {
    task: {
      findFirst: async ({ where }: { where: { id: string; organizationId?: string } }) =>
        where.id === task.id && (!where.organizationId || where.organizationId === task.organizationId)
          ? hydrateTask(task)
          : null,
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
        if (where.id !== task.id || where.organizationId !== task.organizationId || where.status !== task.status) {
          return { count: 0 }
        }
        updateTask(data)
        return { count: 1 }
      },
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
      findFirst: async ({ where }: { where: { id: string; projectId: string } }) =>
        columns.find((column) => column.id === where.id && column.projectId === where.projectId) ?? null,
    },
    $transaction: async <T>(callback: (client: typeof tx) => Promise<T>) => callback(tx),
  } as unknown as PrismaClient

  return { events, prisma }
}

test('moveTaskToColumn auto-assigns an unassigned task moved into In Progress', async () => {
  const task = makeTask()
  const { events, prisma } = makePrisma(task, [
    { id: inProgressColumnId, projectId, category: 'in_progress' },
  ])

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
  assert.equal(result.columnId, inProgressColumnId)
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
  const { events, prisma } = makePrisma(task, [
    { id: inProgressColumnId, projectId, category: 'in_progress' },
  ])

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
