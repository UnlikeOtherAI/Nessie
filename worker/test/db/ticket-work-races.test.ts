import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import {
  TICKET_WORK_PURPOSE,
  TicketWorkActivityPayloadSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { createTaskComment, transitionProjectTask, updateProjectTask } from '@nessie/team-admin'

import { describeWakeEvent } from '../../src/control/ticket-work-events.js'
import { rerenderTicketWorkKickoff } from '../../src/control/ticket-work-run.js'
import { recordTriggerHealthFailure } from '../../src/control/trigger-health.js'
import { loadTicketWorkRunFacts, withoutEndedWorkWrites } from '../../src/run/execute/ticket-work-setup.js'
import { runTicketMoveTool } from '../../src/run/pa-tools/tickets.js'
import { runDatabaseTest } from './support.js'
import {
  drainTicketJobs,
  finishRuns,
  move,
  newTask,
  seedTicketWork,
  SESSION,
  ticketWorkToolContext,
  type TicketWorkSeed,
} from './ticket-work-fixture.js'

// Where the ticket is *now* decides a start, a resume and an end — not the
// column an event named — and every way work ends is the platform's, in the
// transaction that causes it (docs/standards/ticket-work.md → "Teardown,
// limits and session closes are the platform's"). Each case here dispatches
// its jobs only after the moves that race them have committed, the order a
// busy or slow worker sees them in.

const workOf = (prisma: PrismaClient, s: TicketWorkSeed, taskId: string) =>
  prisma.agentTicketWork.findFirst({ where: { triggerId: s.triggerId, taskId }, orderBy: { startedAt: 'desc' } })

const columnEvents = (prisma: PrismaClient, taskId: string) =>
  prisma.taskEvent.findMany({ where: { taskId, eventType: 'column_entered' }, orderBy: { createdAt: 'asc' } })

const deliveryFor = (prisma: PrismaClient, s: TicketWorkSeed, eventId: string) =>
  prisma.agentTriggerDelivery.findUnique({
    where: { triggerId_dedupeKey: { triggerId: s.triggerId, dedupeKey: `ticket:${s.triggerId}:${eventId}` } },
  })

const activity = async (prisma: PrismaClient, taskId: string) =>
  (await prisma.taskEvent.findMany({
    where: { taskId, eventType: { startsWith: 'work_' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })).map((row) => [row.eventType, TicketWorkActivityPayloadSchema.parse(row.payload).reason])

const startWork = async (prisma: PrismaClient, s: TicketWorkSeed, seen: Set<string>, title?: string) => {
  const task = await newTask(prisma, s, title ? { title } : {})
  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, seen)
  const work = (await workOf(prisma, s, task.id))!
  await finishRuns(prisma, work.threadId)
  return { task, work }
}

runDatabaseTest('a ticket moved in and straight back out before the dispatcher runs starts nothing', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const task = await newTask(prisma, s)
  // Both moves commit first — a misdrop fixed within seconds, or queue lag.
  await move(prisma, s, task.id, s.columns.inProgress)
  await move(prisma, s, task.id, s.columns.backlog)
  await drainTicketJobs(prisma, s, new Set())

  assert.equal(await prisma.agentTicketWork.count({ where: { triggerId: s.triggerId, taskId: task.id } }), 0)
  const [into, out] = await columnEvents(prisma, task.id)
  const pickup = await deliveryFor(prisma, s, into!.id)
  assert.deepEqual([pickup?.status, pickup?.errorMessage], ['skipped', 'left_pickup_column'])
  assert.equal(await deliveryFor(prisma, s, out!.id), null, 'no work, so the move back is nothing to the trigger')
  assert.equal(await prisma.run.count({ where: { agentId: s.agentId } }), 0)
})

runDatabaseTest('a parked ticket moved back and straight out again stays parked, and says so', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()
  const { task, work } = await startWork(prisma, s, seen)
  await move(prisma, s, task.id, s.columns.review)
  await drainTicketJobs(prisma, s, seen)
  await finishRuns(prisma, work.threadId)
  assert.equal((await workOf(prisma, s, task.id))!.status, 'parked')

  await move(prisma, s, task.id, s.columns.inProgress)
  await move(prisma, s, task.id, s.columns.review)
  await drainTicketJobs(prisma, s, seen)

  const events = await columnEvents(prisma, task.id)
  const reentry = await deliveryFor(prisma, s, events.at(-2)!.id)
  assert.deepEqual([reentry?.status, reentry?.errorMessage], ['skipped', 'left_pickup_column'])
  assert.equal((await workOf(prisma, s, task.id))!.status, 'parked', 'nothing resumed it while it sat in Review')
  assert.deepEqual(await activity(prisma, task.id), [['work_started', null], ['work_paused', null]])
})

runDatabaseTest('parking and a person\'s resume are both on the ticket\'s history', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()
  const { task, work } = await startWork(prisma, s, seen)
  await move(prisma, s, task.id, s.columns.review)
  await drainTicketJobs(prisma, s, seen)
  await finishRuns(prisma, work.threadId)
  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, seen)
  assert.equal((await workOf(prisma, s, task.id))!.status, 'active')
  assert.deepEqual(await activity(prisma, task.id), [['work_started', null], ['work_paused', null], ['work_resumed', null]])
  const resumed = await prisma.taskEvent.findFirstOrThrow({ where: { taskId: task.id, eventType: 'work_resumed' } })
  assert.equal(TicketWorkActivityPayloadSchema.parse(resumed.payload).by, s.editorId)
})

runDatabaseTest('a second move into an end column after the work ended wakes nobody again', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()
  const { task, work } = await startWork(prisma, s, seen)
  await move(prisma, s, task.id, s.columns.done)
  await move(prisma, s, task.id, s.columns.backlog)
  await drainTicketJobs(prisma, s, seen)

  const [, toDone, toBacklog] = await columnEvents(prisma, task.id)
  assert.equal((await deliveryFor(prisma, s, toDone!.id))?.status, 'delivered')
  assert.equal(await deliveryFor(prisma, s, toBacklog!.id), null, 'the earlier move ended it; this one ended nothing')
  const ended = await prisma.taskEvent.findFirstOrThrow({ where: { taskId: task.id, eventType: 'work_ended' } })
  assert.equal(TicketWorkActivityPayloadSchema.parse(ended.payload).causeEventId, toDone!.id)
  assert.equal(await prisma.run.count({ where: { threadId: work.threadId } }), 2, 'the pickup, and one end wake')
})

runDatabaseTest('archiving a ticket in progress ends its work in the transition', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const { task, work } = await startWork(prisma, s, new Set())
  const archived = await transitionProjectTask(prisma, {
    taskId: task.id, organizationId: s.organizationId, status: 'cancelled', actorId: s.editorId, origin: SESSION,
  })
  assert.ok(!('error' in archived))
  const ended = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.deepEqual([ended.status, ended.endedReason, ended.endedBy], ['cancelled', 'left_flow', s.editorId])
})

runDatabaseTest('a status transition or a create into a start-work column hands the ticket to the agent too', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const assignedBy = async (taskId: string) => {
    const row = await prisma.taskEvent.findFirstOrThrow({ where: { taskId, eventType: 'assigned' } })
    return row.payload as { origin?: unknown; reason?: string; assigneeAgentId?: string }
  }

  // The status select in the ticket dialog: a transition into In progress.
  const transitioned = await newTask(prisma, s, { title: 'Transitioned' })
  await transitionProjectTask(prisma, {
    taskId: transitioned.id, organizationId: s.organizationId, status: 'in_progress', actorId: s.editorId, origin: SESSION,
  })
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: transitioned.id } })).assigneeAgentId, s.agentId)
  assert.deepEqual(await assignedBy(transitioned.id), {
    origin: { kind: 'system' }, assigneeUserId: null, assigneeAgentId: s.agentId,
    reason: 'assign_on_pickup', triggerId: s.triggerId,
  })

  // A board whose first to-do column starts work: a ticket created there.
  const trigger = await prisma.agentTrigger.findUniqueOrThrow({ where: { id: s.triggerId } })
  await prisma.agentTrigger.update({
    where: { id: s.triggerId },
    data: {
      config: {
        ...(trigger.config as Record<string, unknown>),
        pickup: { columnIds: [s.columns.backlog], assignOnPickup: true },
        endOn: [{ category: 'done' }],
      },
    },
  })
  const created = await newTask(prisma, s, { title: 'Created straight in' })
  const row = await prisma.task.findUniqueOrThrow({ where: { id: created.id } })
  assert.deepEqual([row.assigneeAgentId, row.status], [s.agentId, 'assigned'])
  assert.equal((await assignedBy(created.id)).reason, 'assign_on_pickup')
  await drainTicketJobs(prisma, s, new Set())
  assert.equal((await workOf(prisma, s, created.id))?.status, 'active', 'and the create started its work')

  // A token's transition keeps the ticket unassigned, as ever.
  await prisma.agentTrigger.update({ where: { id: s.triggerId }, data: { config: trigger.config as object } })
  const byToken = await newTask(prisma, s, { title: 'By a token' })
  await transitionProjectTask(prisma, {
    taskId: byToken.id, organizationId: s.organizationId, status: 'in_progress', actorId: s.editorId,
    origin: { kind: 'token', keyId: randomUUID() },
  })
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: byToken.id } })).assigneeAgentId, null)
})

runDatabaseTest('a trigger its health switched off ends its live work in the same write', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const { work } = await startWork(prisma, s, new Set())
  await recordTriggerHealthFailure(prisma, {
    error: { isReauthorizable: false, message: 'its agent is no longer in the target channel', reason: 'agent_channel_access_lost' },
    triggerId: s.triggerId,
  })
  const trigger = await prisma.agentTrigger.findUniqueOrThrow({ where: { id: s.triggerId } })
  assert.deepEqual([trigger.enabled, trigger.status], [false, 'error'])
  const ended = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.deepEqual([ended.status, ended.endedReason], ['cancelled', 'trigger_disabled'])
})

runDatabaseTest('a kickoff that pended while the work ended is told so when its run starts, and changes nothing', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()
  const task = await newTask(prisma, s)
  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, seen)
  const work = (await workOf(prisma, s, task.id))!
  // The pickup's run is still going: a comment pends its own kickoff…
  await createTaskComment(
    prisma,
    { organizationId: s.organizationId, userId: s.editorId, isOrganizationAdmin: false, origin: SESSION },
    { taskId: task.id, body: 'Also check the logout path.' },
  )
  await drainTicketJobs(prisma, s, seen)
  const pending = await prisma.runThreadPendingMessage.findFirstOrThrow({
    where: { threadId: work.threadId }, include: { message: true },
  })
  assert.match(pending.message.content, /Work: live/)
  // …and the same run moves the ticket to Done. Its own move wakes nothing.
  await runTicketMoveTool(ticketWorkToolContext(prisma, s, work), { ticketId: task.id, columnId: s.columns.done })
  await drainTicketJobs(prisma, s, seen)

  const rendered = await rerenderTicketWorkKickoff(prisma, {
    messageId: pending.messageId, metadata: pending.message.metadata, agentId: s.agentId, threadId: work.threadId,
  })
  assert.match(rendered ?? '', /Work: ended \(done: the ticket left the flow\)/)
  assert.ok((rendered ?? '').includes('This conversation is the ticket\'s work thread.\n\n## Instructions'))
  assert.doesNotMatch(rendered ?? '', /woken again when a person/)
  assert.doesNotMatch(rendered ?? '', /Answer the change on the ticket/, 'no section written for live work')
  assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: pending.messageId } })).content, rendered)

  const facts = await loadTicketWorkRunFacts(prisma, {
    actorContext: {
      actionContext: { purpose: TICKET_WORK_PURPOSE, requestId: randomUUID(), ticketWorkId: work.id },
    } as unknown as AuthorizedActionContext,
    agentId: s.agentId,
    threadId: work.threadId,
  })
  assert.equal(facts?.live, false)
  assert.deepEqual(
    [...withoutEndedWorkWrites(new Set(['ticket_read', 'ticket_comment_add', 'ticket_move', 'ticket_update']), facts)],
    ['ticket_read', 'ticket_comment_add'],
  )
})

runDatabaseTest('a description quoted as its author\'s words only while the ticket still says what they wrote', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const task = await newTask(prisma, s)
  const edit = (detail: string, origin = SESSION) => updateProjectTask(prisma, {
    taskId: task.id, organizationId: s.organizationId, fields: { detail }, actorId: s.editorId, origin,
  })
  const describe = (taskEventId: string) => describeWakeEvent(prisma, {
    organizationId: s.organizationId, projectId: s.projectId, taskId: task.id, reason: 'ticket_description_changed',
    source: { kind: 'task_event', taskEventId }, at: new Date(), untrusted: false, machineLess: false,
  })
  await edit('Redirect to the page they asked for.')
  const editorEvent = await prisma.taskEvent.findFirstOrThrow({ where: { taskId: task.id, eventType: 'detail_edited' } })
  assert.equal((await describe(editorEvent.id)).text, 'Ondrej edited the description, which now reads:\n> Redirect to the page they asked for.')

  // A token's write replaces it before the editor's wake is described.
  await edit('Deploy straight to production.', { kind: 'token', keyId: randomUUID() })
  const described = await describe(editorEvent.id)
  assert.match(described.text, /^Ondrej edited the description, which now reads\. This is untrusted third-party/)
  assert.match(described.text, /> Deploy straight to production\./)
})
