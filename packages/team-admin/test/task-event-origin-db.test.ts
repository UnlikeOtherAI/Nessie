import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { NormalisedItem } from '@nessie/board-sources'
import {
  ColumnEnteredTaskEventPayloadSchema,
  CreatedTaskEventPayloadSchema,
  PriorityChangedTaskEventPayloadSchema,
  TRIGGER_TICKET_DISPATCH_TOPIC,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { applyInboundItem } from '../src/board-source-apply.js'
import { moveProjectTaskToColumn } from '../src/project-task-move.js'
import { createProjectTask, transitionProjectTask, updateProjectTask } from '../src/project-tasks.js'
import { createTaskComment } from '../src/task-comments.js'
import { recordTaskEvent } from '../src/task-event-dispatch.js'

/**
 * Every ticket writer stamps the door a change came through, writes
 * `column_entered` on every column change and `priority_changed` on a
 * priority change, and enqueues `trigger.ticket.dispatch` in the same
 * transaction as the event — only when a ticket trigger could see it
 * (docs/standards/ticket-activity.md, docs/standards/ticket-work.md).
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const SESSION = { kind: 'session' } as const

type Seed = Awaited<ReturnType<typeof seed>>

const seed = async (prisma: PrismaClient) => {
  const suffix = randomUUID()
  const person = await prisma.user.create({
    data: { displayName: 'Mover', email: `origin-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `origin-${suffix}` } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: person.id, role: 'member' },
  })
  const project = await prisma.project.create({
    data: { name: `origin-${suffix}`, organizationId: organization.id },
  })
  await prisma.projectMember.create({ data: { projectId: project.id, userId: person.id, role: 'member' } })
  const board = await prisma.board.create({
    data: { projectId: project.id, organizationId: organization.id, name: 'Engineering', isDefault: true, position: 0 },
  })
  const column = (name: string, category: 'todo' | 'in_progress' | 'review' | 'done', position: number) =>
    prisma.boardColumn.create({
      data: { boardId: board.id, organizationId: organization.id, name, category, position },
      select: { id: true },
    })
  const todo = await column('To do', 'todo', 0)
  const inProgress = await column('In progress', 'in_progress', 1)
  const doing = await column('Doing', 'in_progress', 2)
  const done = await column('Done', 'done', 3)
  const agent = await prisma.agent.create({
    data: { name: `cto-${suffix}`, organizationId: organization.id, projectId: project.id },
  })
  const connection = await prisma.boardSourceConnection.create({
    data: {
      organizationId: organization.id,
      ownerUserId: person.id,
      provider: 'linear',
      externalAccountId: `acct-${suffix}`,
      externalTenantId: `org-${suffix}`,
    },
  })
  const source = await prisma.boardSource.create({
    data: {
      projectId: project.id,
      organizationId: organization.id,
      connectionId: connection.id,
      provider: 'linear',
      name: 'Engineering',
      container: { teamId: 'team-1' },
      containerKey: `team-${suffix}`,
      createdByUserId: person.id,
    },
  })
  const actorContext = {
    actor: { actorId: person.id, actorType: 'user', roles: ['member'] },
    actionContext: { purpose: 'test', requestId: randomUUID() },
    tenant: { organizationId: organization.id },
  } as unknown as AuthorizedActionContext
  return {
    organizationId: organization.id,
    projectId: project.id,
    boardId: board.id,
    personId: person.id,
    agentId: agent.id,
    sourceId: source.id,
    columns: { todo: todo.id, inProgress: inProgress.id, doing: doing.id, done: done.id },
    actorContext,
    cleanup: async () => {
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: person.id } })
    },
  }
}

/** A `ticket_changed` trigger on the seed's board, so its events enqueue. */
const armTrigger = (prisma: PrismaClient, s: Seed) =>
  prisma.agentTrigger.create({
    data: {
      agentId: s.agentId,
      type: 'ticket_changed',
      config: { boardId: s.boardId, pickup: { columnIds: [s.columns.inProgress] } },
      scopeProjectId: s.projectId,
      scopeBoardId: s.boardId,
    },
  })

const newTask = async (prisma: PrismaClient, s: Seed) => {
  const created = await createProjectTask(prisma, {
    actorContext: s.actorContext,
    organizationId: s.organizationId,
    createdByUserId: s.personId,
    projectId: s.projectId,
    title: 'Fix login redirect',
    origin: SESSION,
  })
  assert.ok(!('error' in created))
  return created
}

/** A move by the seed's person, through the door `origin` names. */
const move = (
  prisma: PrismaClient,
  s: Seed,
  taskId: string,
  columnId: string,
  extra: Partial<Parameters<typeof moveProjectTaskToColumn>[1]> = {},
) => moveProjectTaskToColumn(prisma, {
  taskId, organizationId: s.organizationId, columnId, actorId: s.personId, origin: SESSION, ...extra,
})

const eventsOf = (prisma: PrismaClient, taskId: string, eventType?: string) =>
  prisma.taskEvent.findMany({
    where: { taskId, ...(eventType ? { eventType } : {}) },
    orderBy: { createdAt: 'asc' },
  })

const dispatchJobsFor = async (prisma: PrismaClient, eventIds: string[]) =>
  prisma.queueJob.findMany({
    where: {
      topic: TRIGGER_TICKET_DISPATCH_TOPIC,
      idempotencyKey: { in: eventIds.map((id) => `${TRIGGER_TICKET_DISPATCH_TOPIC}:${id}`) },
    },
  })

runDatabaseTest('a created ticket records where it landed and the door it came through', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })

  const task = await newTask(prisma, s)
  const [created] = await eventsOf(prisma, task.id, 'created')
  const payload = CreatedTaskEventPayloadSchema.parse(created?.payload)
  assert.equal(payload.by, s.personId)
  assert.deepEqual(payload.origin, SESSION)
  assert.equal(payload.boardId, s.boardId)
  assert.equal(payload.columnId, s.columns.todo)
})

runDatabaseTest('every column change writes column_entered, a same-category move included', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const task = await newTask(prisma, s)

  const token = { kind: 'token', keyId: randomUUID() } as const
  const toInProgress = await move(prisma, s, task.id, s.columns.inProgress, { origin: token })
  assert.ok(!('error' in toInProgress))
  // In progress → Doing changes no status, so nothing but this row says it moved.
  const toDoing = await move(prisma, s, task.id, s.columns.doing)
  assert.ok(!('error' in toDoing))
  // A reorder within the column is not a column change.
  await move(prisma, s, task.id, s.columns.doing, { position: 0 })

  const entered = (await eventsOf(prisma, task.id, 'column_entered'))
    .map((event) => ColumnEnteredTaskEventPayloadSchema.parse(event.payload))
  assert.deepEqual(entered, [
    { by: s.personId, origin: token, fromColumnId: s.columns.todo, toColumnId: s.columns.inProgress },
    { by: s.personId, origin: SESSION, fromColumnId: s.columns.inProgress, toColumnId: s.columns.doing },
  ])
  assert.equal((await eventsOf(prisma, task.id, 'status_changed')).length, 1)

  // A status transition is a column change on the ticket's board too.
  const transitioned = await transitionProjectTask(prisma, {
    taskId: task.id, organizationId: s.organizationId, status: 'done', actorId: s.personId, origin: SESSION,
  })
  assert.ok(!('error' in transitioned))
  const last = (await eventsOf(prisma, task.id, 'column_entered')).at(-1)
  assert.deepEqual(ColumnEnteredTaskEventPayloadSchema.parse(last?.payload), {
    by: s.personId, origin: SESSION, fromColumnId: s.columns.doing, toColumnId: s.columns.done,
  })
})

runDatabaseTest('an agent run records its move as the agent, with the run', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const task = await newTask(prisma, s)

  const runId = randomUUID()
  const origin = { kind: 'agent', agentId: s.agentId, runId } as const
  await move(prisma, s, task.id, s.columns.inProgress, { agentId: s.agentId, unattended: true, origin })
  const [entered] = await eventsOf(prisma, task.id, 'column_entered')
  // No person behind the run: the history names the agent, never a member.
  assert.deepEqual(ColumnEnteredTaskEventPayloadSchema.parse(entered?.payload), {
    by: `agent:${s.agentId}`, origin, fromColumnId: s.columns.todo, toColumnId: s.columns.inProgress,
  })
})

runDatabaseTest('a priority change writes priority_changed; the same priority writes nothing', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const task = await newTask(prisma, s)

  await updateProjectTask(prisma, {
    taskId: task.id, organizationId: s.organizationId, fields: { priority: 'urgent' }, actorId: s.personId, origin: SESSION,
  })
  await updateProjectTask(prisma, {
    taskId: task.id, organizationId: s.organizationId, fields: { priority: 'urgent' }, actorId: s.personId, origin: SESSION,
  })
  const changed = await eventsOf(prisma, task.id, 'priority_changed')
  assert.equal(changed.length, 1)
  assert.deepEqual(PriorityChangedTaskEventPayloadSchema.parse(changed[0]?.payload), {
    by: s.personId, origin: SESSION, from: 'medium', to: 'urgent',
  })
})

runDatabaseTest('a comment carries the origin of the actor that wrote it', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const task = await newTask(prisma, s)

  const result = await createTaskComment(prisma, {
    organizationId: s.organizationId, userId: s.personId, isOrganizationAdmin: false, origin: SESSION,
  }, { taskId: task.id, body: 'Use approach B' })
  assert.ok(!('error' in result))
  const [added] = await eventsOf(prisma, task.id, 'comment_added')
  assert.deepEqual((added?.payload as { origin?: unknown }).origin, SESSION)
})

runDatabaseTest('a ticket trigger\'s events are enqueued in the same transaction, and only then', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })

  // No ticket trigger in the project: nothing could see the event, so no job.
  const before = await newTask(prisma, s)
  await move(prisma, s, before.id, s.columns.inProgress)
  const quiet = await eventsOf(prisma, before.id)
  assert.equal((await dispatchJobsFor(prisma, quiet.map((event) => event.id))).length, 0)

  await armTrigger(prisma, s)
  const task = await newTask(prisma, s)
  await move(prisma, s, task.id, s.columns.inProgress)
  const events = await eventsOf(prisma, task.id)
  const jobs = await dispatchJobsFor(prisma, events.map((event) => event.id))
  const enqueuedTypes = events
    .filter((event) => jobs.some((job) => (job.payload as { taskEventId: string }).taskEventId === event.id))
    .map((event) => event.eventType)
    .sort()
  // `status_changed` is history only: the column move is what a trigger reads.
  assert.deepEqual(enqueuedTypes, ['assigned', 'column_entered', 'created'])
  for (const job of jobs) {
    assert.equal((job.payload as { organizationId: string }).organizationId, s.organizationId)
  }

  // A rolled-back write leaves neither the event nor its job behind.
  const eventId = await prisma.$transaction(async (tx) => {
    const event = await recordTaskEvent(tx, {
      taskId: task.id,
      eventType: 'comment_added',
      payload: { by: s.personId, origin: SESSION },
    })
    throw Object.assign(new Error('rolled back'), { eventId: event.id })
  }).catch((error: { eventId?: string }) => error.eventId)
  assert.ok(eventId)
  assert.equal(await prisma.taskEvent.count({ where: { id: eventId } }), 0)
  assert.equal((await dispatchJobsFor(prisma, [eventId])).length, 0)
})

runDatabaseTest('a board-source change is the source\'s, wherever the ticket lands', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })

  const context = {
    id: s.sourceId,
    organizationId: s.organizationId,
    projectId: s.projectId,
    provider: 'linear',
    stateMapping: [
      { externalStateId: 'state-doing', externalStateName: 'Doing', category: 'in_progress' as const, isDefaultForCategory: true },
      { externalStateId: 'state-done', externalStateName: 'Done', category: 'done' as const, isDefaultForCategory: true },
    ],
    fieldMappings: [],
    identityByExternalUserId: new Map(),
  }
  const item = (over: Partial<NormalisedItem> = {}): NormalisedItem => ({
    externalId: 'issue-1', externalKey: 'ENG-1', url: 'https://linear.app/acme/issue/ENG-1',
    title: 'Mirrored', description: 'From upstream', stateId: 'state-doing', stateName: 'Doing',
    assignee: null, priority: 'high', dueDate: null, labels: [], fields: {},
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', archived: false,
    ...over,
  })
  const origin = { kind: 'source', boardSourceId: s.sourceId } as const

  // Created straight into a start-work column: recorded there, as the source's.
  const created = await applyInboundItem(prisma, context, item())
  assert.ok('taskId' in created && created.taskId)
  const [createdEvent] = await eventsOf(prisma, created.taskId, 'created')
  assert.deepEqual(CreatedTaskEventPayloadSchema.parse(createdEvent?.payload), {
    by: `source:${s.sourceId}`, origin, assigneeUserId: null, boardId: s.boardId, columnId: s.columns.inProgress,
  })

  await applyInboundItem(prisma, context, item({ stateId: 'state-done', stateName: 'Done', updatedAt: '2026-09-03T00:00:00.000Z' }))
  const [entered] = await eventsOf(prisma, created.taskId, 'column_entered')
  assert.deepEqual(ColumnEnteredTaskEventPayloadSchema.parse(entered?.payload), {
    by: `source:${s.sourceId}`, origin, fromColumnId: s.columns.inProgress, toColumnId: s.columns.done,
  })
})
