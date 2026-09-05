import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  createBoard,
  listBoardTasks,
  listBoards,
  moveProjectTaskToColumn,
  resolveBoardPlacement,
  transitionProjectTask,
} from '../src/index.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const columns = [
  { id: 'todo-1', category: 'todo', position: 0 },
  { id: 'todo-2', category: 'todo', position: 1 },
  { id: 'doing-1', category: 'in_progress', position: 2 },
  { id: 'done-1', category: 'done', position: 3 },
]

test('a pin whose column still matches the status is honoured', () => {
  const placement = resolveBoardPlacement(
    { status: 'inbox', archivedAt: null },
    columns,
    { columnId: 'todo-2', position: 3 },
  )
  assert.deepEqual(placement, { columnId: 'todo-2', position: 3 })
})

// The bug this rule was moved server-side to fix: the client's `placeTask`
// honoured a pin whenever the column still *existed*, without checking its
// category still matched. A card somebody dragged into "In progress" that an
// agent run then completed stayed rendered in "In progress".
test('a pin whose column no longer matches the status is ignored', () => {
  const placement = resolveBoardPlacement(
    { status: 'done', archivedAt: null },
    columns,
    { columnId: 'doing-1', position: 0 },
  )
  assert.deepEqual(placement, { columnId: 'done-1', position: null })
})

test('an unpinned task falls to the first column of its category', () => {
  const placement = resolveBoardPlacement({ status: 'inbox', archivedAt: null }, columns, undefined)
  assert.deepEqual(placement, { columnId: 'todo-1', position: null })
})

test('a board with no column for the category does not show the task', () => {
  const reviewless = columns.filter((column) => column.category !== 'review')
  const placement = resolveBoardPlacement(
    { status: 'review', archivedAt: null },
    reviewless,
    undefined,
  )
  assert.equal(placement, null)
})

test('archived work belongs to no column on any board', () => {
  assert.equal(
    resolveBoardPlacement({ status: 'cancelled', archivedAt: null }, columns, undefined),
    null,
  )
  assert.equal(
    resolveBoardPlacement({ status: 'inbox', archivedAt: new Date() }, columns, undefined),
    null,
  )
})

type Seed = {
  organizationId: string
  projectId: string
  taskId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Board tester', email: `board-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `boards-${suffix}` } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const task = await prisma.task.create({
    data: {
      organizationId: organization.id,
      projectId: project.id,
      status: 'inbox',
      title: 'Shared task',
    },
  })
  return {
    organizationId: organization.id,
    projectId: project.id,
    taskId: task.id,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, seeded: Seed): Promise<void> => {
  await prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
  await prisma.user.deleteMany({ where: { id: seeded.userId } })
}

runDatabaseTest('two boards over one task pool remember their own placements', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const project = { id: seeded.projectId, organizationId: seeded.organizationId }
    // `listBoards` lazily seeds the default board for a project created
    // without one, which is what a project made before boards existed has.
    const [defaultBoard] = await listBoards(prisma, project)
    assert.ok(defaultBoard)
    const second = await createBoard(prisma, project, { name: 'Second' })
    assert.ok('columns' in second)

    const firstTodo = defaultBoard.columns.find((column) => column.category === 'todo')
    const secondDoing = second.columns.find((column) => column.category === 'in_progress')
    assert.ok(firstTodo && secondDoing)

    // Move on the second board only.
    const moved = await moveProjectTaskToColumn(prisma, {
      taskId: seeded.taskId,
      organizationId: seeded.organizationId,
      columnId: secondDoing.id,
      actorId: seeded.userId,
      position: 0,
    })
    assert.ok(!('error' in moved), JSON.stringify(moved))

    const onSecond = await listBoardTasks(prisma, second, { limit: 50 })
    assert.equal(onSecond.tasks[0]?.columnId, secondDoing.id)

    // The first board has no placement of its own, so it shows the task
    // wherever the (now `in_progress`) status says — not in its To do column.
    const onFirst = await listBoardTasks(prisma, defaultBoard, { limit: 50 })
    const firstDoing = defaultBoard.columns.find((column) => column.category === 'in_progress')
    assert.equal(onFirst.tasks[0]?.columnId, firstDoing?.id)
    assert.notEqual(onFirst.tasks[0]?.columnId, firstTodo.id)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('completing a task moves it to Done on a board it was pinned on', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const project = { id: seeded.projectId, organizationId: seeded.organizationId }
    const [board] = await listBoards(prisma, project)
    assert.ok(board)
    const doing = board.columns.find((column) => column.category === 'in_progress')
    const done = board.columns.find((column) => column.category === 'done')
    assert.ok(doing && done)

    await moveProjectTaskToColumn(prisma, {
      taskId: seeded.taskId,
      organizationId: seeded.organizationId,
      columnId: doing.id,
      actorId: seeded.userId,
      position: 0,
    })
    const pinned = await listBoardTasks(prisma, board, { limit: 50 })
    assert.equal(pinned.tasks[0]?.columnId, doing.id)

    // What an agent run does at the end of its work: it writes `status` and
    // knows nothing about boards.
    const completed = await transitionProjectTask(prisma, {
      taskId: seeded.taskId,
      organizationId: seeded.organizationId,
      status: 'done',
      actorId: seeded.userId,
    })
    assert.ok(!('error' in completed), JSON.stringify(completed))

    const after = await listBoardTasks(prisma, board, { limit: 50 })
    assert.equal(after.tasks[0]?.columnId, done.id)
    // The stale pin is gone, not merely ignored.
    assert.equal(
      await prisma.taskBoardPlacement.count({
        where: { taskId: seeded.taskId, columnId: doing.id },
      }),
      0,
    )
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})
