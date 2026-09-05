import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  createBoard,
  createTaskFieldDefinition,
  deleteTaskFieldDefinition,
  listBoardTasks,
  listBoards,
  listTaskFieldDefinitions,
  updateBoard,
  updateProjectTask,
  validateFieldValuesPatch,
} from '../src/index.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const definition = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  name: 'Type',
  type: 'select' as const,
  position: 0,
  showOnCard: false,
  options: [
    { id: 'bug', label: 'Bug' },
    { id: 'chore', label: 'Chore', retiredAt: '2026-01-01T00:00:00.000Z' },
  ],
  config: {},
  ...over,
})

test('a select value must be a live option', () => {
  const definitions = [definition()]
  assert.equal(validateFieldValuesPatch(definitions, { [definition().id]: 'bug' }), null)
  assert.deepEqual(validateFieldValuesPatch(definitions, { [definition().id]: 'nope' }), {
    error: 'FIELD_VALUE_INVALID',
    fieldId: definition().id,
    reason: 'not an available option',
  })
  // A retired option leaves every picker, so it can no longer be set.
  assert.equal(
    (validateFieldValuesPatch(definitions, { [definition().id]: 'chore' }) as { error: string })
      .error,
    'FIELD_VALUE_INVALID',
  )
})

test('clearing a field is always allowed', () => {
  assert.equal(validateFieldValuesPatch([definition()], { [definition().id]: null }), null)
})

test('a value for a field this project does not define is refused', () => {
  assert.deepEqual(validateFieldValuesPatch([], { [definition().id]: 'bug' }), {
    error: 'FIELD_UNKNOWN',
    fieldId: definition().id,
  })
})

test('a url field takes https only', () => {
  const url = definition({ type: 'url' as const, options: [] })
  assert.equal(validateFieldValuesPatch([url], { [url.id]: 'https://example.test/x' }), null)
  for (const bad of ['http://example.test', 'javascript:alert(1)', 'data:text/html,x']) {
    assert.equal(
      (validateFieldValuesPatch([url], { [url.id]: bad }) as { error: string }).error,
      'FIELD_VALUE_INVALID',
      bad,
    )
  }
})

test('a number field honours its bounds', () => {
  const points = definition({ type: 'number' as const, options: [], config: { min: 0, max: 10 } })
  assert.equal(validateFieldValuesPatch([points], { [points.id]: 5 }), null)
  assert.equal(
    (validateFieldValuesPatch([points], { [points.id]: 11 }) as { error: string }).error,
    'FIELD_VALUE_INVALID',
  )
  assert.equal(
    (validateFieldValuesPatch([points], { [points.id]: 'five' }) as { error: string }).error,
    'FIELD_VALUE_INVALID',
  )
})

type Seed = { organizationId: string; projectId: string; taskId: string; userId: string }

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Field tester', email: `fields-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `fields-${suffix}` } })
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
      title: 'Field task',
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

runDatabaseTest('a board filtered on an option shows only matching cards', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const project = { id: seeded.projectId, organizationId: seeded.organizationId }
    // Seed the project's default board first: `listBoards` only lazily creates
    // one when the project has none, so creating the filtered board ahead of it
    // would leave that board as the project's only one.
    const [defaultBoard] = await listBoards(prisma, project)
    assert.ok(defaultBoard)

    const field = await createTaskFieldDefinition(prisma, project, {
      name: 'Type',
      type: 'select',
      options: [
        { id: 'bug', label: 'Bug' },
        { id: 'chore', label: 'Chore' },
      ],
    })
    assert.ok('id' in field)

    const other = await prisma.task.create({
      data: {
        organizationId: seeded.organizationId,
        projectId: seeded.projectId,
        status: 'inbox',
        title: 'Chore task',
      },
    })
    await updateProjectTask(prisma, {
      taskId: seeded.taskId,
      organizationId: seeded.organizationId,
      fields: { fieldValues: { [field.id]: 'bug' } },
    })
    await updateProjectTask(prisma, {
      taskId: other.id,
      organizationId: seeded.organizationId,
      fields: { fieldValues: { [field.id]: 'chore' } },
    })

    const bugsOnly = await createBoard(prisma, project, { name: 'Bugs' })
    assert.ok('columns' in bugsOnly)
    const filtered = await updateBoard(prisma, project.id, bugsOnly.id, {
      filter: { sources: 'all', field: { fieldId: field.id, optionIds: ['bug'] } },
    })
    assert.ok('columns' in filtered)

    const { tasks } = await listBoardTasks(prisma, filtered, { limit: 50 })
    assert.deepEqual(
      tasks.map((task) => task.title),
      ['Field task'],
    )

    // The unfiltered board still shows both, so the narrowing is the board's,
    // not something the field did to the project.
    const all = await listBoardTasks(prisma, defaultBoard, { limit: 50 })
    assert.equal(all.tasks.length, 2)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('deleting a definition clears the values every task held', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const project = { id: seeded.projectId, organizationId: seeded.organizationId }
    const field = await createTaskFieldDefinition(prisma, project, {
      name: 'Estimate',
      type: 'number',
    })
    assert.ok('id' in field)
    await updateProjectTask(prisma, {
      taskId: seeded.taskId,
      organizationId: seeded.organizationId,
      fields: { fieldValues: { [field.id]: 3 } },
    })
    const before = await prisma.task.findUniqueOrThrow({
      where: { id: seeded.taskId },
      select: { fieldValues: true },
    })
    assert.deepEqual(before.fieldValues, { [field.id]: 3 })

    assert.deepEqual(await deleteTaskFieldDefinition(prisma, project.id, field.id), { ok: true })

    const after = await prisma.task.findUniqueOrThrow({
      where: { id: seeded.taskId },
      select: { fieldValues: true },
    })
    assert.deepEqual(after.fieldValues, {})
    assert.deepEqual(await listTaskFieldDefinitions(prisma, project.id), [])
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a patch merges rather than replacing the whole bag', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const project = { id: seeded.projectId, organizationId: seeded.organizationId }
    const first = await createTaskFieldDefinition(prisma, project, { name: 'A', type: 'text' })
    const second = await createTaskFieldDefinition(prisma, project, { name: 'B', type: 'text' })
    assert.ok('id' in first && 'id' in second)

    await updateProjectTask(prisma, {
      taskId: seeded.taskId,
      organizationId: seeded.organizationId,
      fields: { fieldValues: { [first.id]: 'one', [second.id]: 'two' } },
    })
    // Touch only the first: the second must survive untouched.
    const updated = await updateProjectTask(prisma, {
      taskId: seeded.taskId,
      organizationId: seeded.organizationId,
      fields: { fieldValues: { [first.id]: 'changed' } },
    })
    assert.ok(!('error' in updated))
    assert.deepEqual(updated.fieldValues, { [first.id]: 'changed', [second.id]: 'two' })

    // …and null clears just that key.
    const cleared = await updateProjectTask(prisma, {
      taskId: seeded.taskId,
      organizationId: seeded.organizationId,
      fields: { fieldValues: { [first.id]: null } },
    })
    assert.ok(!('error' in cleared))
    assert.deepEqual(cleared.fieldValues, { [second.id]: 'two' })
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})
