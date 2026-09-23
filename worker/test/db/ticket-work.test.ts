import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import {
  AuthorizedActionContextSchema,
  RunExecuteJobPayloadSchema,
  TicketWorkActivityPayloadSchema,
  TicketWorkThreadEventSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import {
  assignProjectTask,
  createTaskComment,
  deleteAgentTrigger,
  updateAgentTrigger,
} from '@nessie/team-admin'

import { claimThreadRunOrPend, drainPendingThreadMessages } from '../../src/run/thread-serialization.js'
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

// The work record, its thread and its `ticket.work` runs against Postgres,
// driven only through the real writers and the worker's own dispatch jobs
// (docs/standards/ticket-work.md): a pickup starts one record in one thread,
// wakes coalesce, limits and teardown are the platform's, and every run acts
// as the agent.

const workOf = (prisma: PrismaClient, s: TicketWorkSeed, taskId: string) =>
  prisma.agentTicketWork.findFirstOrThrow({ where: { triggerId: s.triggerId, taskId }, orderBy: { startedAt: 'desc' } })

const latestEvent = (prisma: PrismaClient, taskId: string, eventType: string) =>
  prisma.taskEvent.findFirstOrThrow({ where: { taskId, eventType }, orderBy: { createdAt: 'desc' } })

const deliveryFor = (prisma: PrismaClient, s: TicketWorkSeed, dedupeKey: string) =>
  prisma.agentTriggerDelivery.findUniqueOrThrow({
    where: { triggerId_dedupeKey: { triggerId: s.triggerId, dedupeKey } },
  })

const threadRows = async (prisma: PrismaClient, threadId: string) =>
  (await prisma.message.findMany({ where: { threadId, role: 'system' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
    .flatMap((message) => {
      const metadata = message.metadata as Record<string, unknown> | null
      const parsed = TicketWorkThreadEventSchema.safeParse(metadata?.ticketWorkEvent)
      return parsed.success ? [{ ...parsed.data, content: message.content }] : []
    })

const kickoffs = async (prisma: PrismaClient, threadId: string) =>
  (await prisma.message.findMany({
    where: { threadId, role: 'system' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })).filter((message) => Boolean((message.metadata as Record<string, unknown> | null)?.ticketWorkKickoff))

const comment = (prisma: PrismaClient, s: TicketWorkSeed, taskId: string, body: string, userId = s.editorId) =>
  createTaskComment(
    prisma,
    { organizationId: s.organizationId, userId, isOrganizationAdmin: false, origin: SESSION },
    { taskId, body },
  )

const runJobFor = async (prisma: PrismaClient, runId: string) => {
  const job = await prisma.queueJob.findFirstOrThrow({
    where: { topic: 'run.execute', payload: { path: ['runId'], equals: runId } },
  })
  return RunExecuteJobPayloadSchema.parse(job.payload)
}

runDatabaseTest('a board editor\'s move starts work: one record, its own thread, and a run that acts as the agent', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()
  const task = await newTask(prisma, s)
  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, seen)

  const entered = await latestEvent(prisma, task.id, 'column_entered')
  const work = await workOf(prisma, s, task.id)
  assert.equal(work.status, 'active')
  assert.equal(work.startedByUserId, s.editorId)
  assert.equal(work.startedByEventId, entered.id)
  assert.equal(work.wakeCount, 1)
  assert.equal(work.lastWakeReason, 'pickup')
  assert.equal(work.executorId, null, 'no machine does ticket work in T1')
  const delivery = await deliveryFor(prisma, s, `ticket:${s.triggerId}:${entered.id}`)
  assert.equal(delivery.status, 'delivered')
  assert.equal((delivery.payload as { workId?: string }).workId, work.id)

  // One thread per (trigger, ticket), in the target channel, with the agent.
  const thread = await prisma.thread.findUniqueOrThrow({ where: { id: work.threadId } })
  assert.equal(thread.channelId, s.channelId)
  assert.equal(thread.agentId, s.agentId)
  assert.equal(thread.startedByUserId, null)
  assert.equal(thread.title, 'Fix login redirect')
  assert.deepEqual(thread.metadata, { taskId: task.id, triggerId: s.triggerId })

  // assignOnPickup handed the unassigned ticket to the agent, as the platform.
  const ticket = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
  assert.equal(ticket.assigneeAgentId, s.agentId)
  assert.equal(ticket.assigneeUserId, null)
  const assigned = await latestEvent(prisma, task.id, 'assigned')
  assert.deepEqual((assigned.payload as { origin?: unknown }).origin, { kind: 'system' })
  assert.equal((assigned.payload as { reason?: string }).reason, 'assign_on_pickup')

  const started = TicketWorkActivityPayloadSchema.parse((await latestEvent(prisma, task.id, 'work_started')).payload)
  assert.deepEqual(
    { by: started.by, workId: started.workId, status: started.status, reason: started.reason },
    { by: s.editorId, workId: work.id, status: 'active', reason: null },
  )

  // A compact wake row, and a hidden kickoff with its three blocks.
  const rows = await threadRows(prisma, work.threadId)
  assert.deepEqual(rows.map((row) => [row.kind, row.reason]), [['woken', 'pickup']])
  assert.match(rows[0]!.content, /^Woken: work started — Ondrej moved the ticket into a start-work column$/)
  assert.doesNotMatch(rows[0]!.content, /Fix login redirect/, 'a thread row never repeats ticket text')
  const [kickoff] = await kickoffs(prisma, work.threadId)
  assert.ok(kickoff)
  assert.ok(kickoff.content.startsWith('## Why you were woken\npickup: Ondrej moved the ticket from Backlog (todo) into In progress (in_progress)'))
  assert.match(kickoff.content, new RegExp(`## State\\nTicket "Fix login redirect" \\(ticketId=${task.id}\\), board Engineering, column In progress \\(in_progress\\)`))
  assert.match(kickoff.content, new RegExp(`Done \\(done\\) columnId=${s.columns.done}`))
  assert.match(kickoff.content, /this is wake 1 of 30/)
  assert.match(kickoff.content, /Machine: none/)
  assert.ok(kickoff.content.includes('## Instructions\nRead the ticket, then comment what you will do.\nSay hello on the ticket.'))
  assert.doesNotMatch(kickoff.content, /Answer the change/, 'only the section that matches the reason')

  // The run: the agent, no effective user, not interactive, purpose ticket.work.
  const run = await prisma.run.findFirstOrThrow({ where: { threadId: work.threadId } })
  assert.equal(run.agentId, s.agentId)
  assert.equal(run.triggerDeliveryId, delivery.id)
  const job = await runJobFor(prisma, run.id)
  assert.equal(job.messageId, kickoff.id)
  assert.equal(job.actorContext.actor.actorType, 'agent')
  assert.equal(job.actorContext.actor.actorId, s.agentId)
  assert.equal(job.actorContext.actionContext.effectiveUserId, undefined)
  assert.equal(job.actorContext.actionContext.purpose, 'ticket.work')
  assert.equal(job.actorContext.actionContext.ticketWorkId, work.id)
  assert.notEqual(job.interactive, true)
})

runDatabaseTest('wakes while the run is busy fold into one pending kickoff, and a person\'s message is never consumed by it', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()
  const task = await newTask(prisma, s)
  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, seen)
  const work = await workOf(prisma, s, task.id)

  // A person's ordinary message pends in the same thread while the pickup
  // run is still going (a mixed batch in the making).
  const personMessage = await prisma.message.create({
    data: { threadId: work.threadId, userId: s.editorId, role: 'user', content: 'Unrelated question for the room.' },
  })
  const personContext: AuthorizedActionContext = {
    actor: { actorId: s.editorId, actorType: 'user', roles: ['member'] },
    actionContext: { requestId: randomUUID() },
    tenant: { organizationId: s.organizationId },
  } as unknown as AuthorizedActionContext
  await prisma.$transaction((tx) => claimThreadRunOrPend(tx, {
    agentId: s.agentId,
    threadId: work.threadId,
    pending: { actorContext: personContext, channelId: s.channelId, interactive: true, messageId: personMessage.id },
  }))

  assert.ok(!('error' in await comment(prisma, s, task.id, 'Please use the new redirect URL.')))
  await drainTicketJobs(prisma, s, seen)
  assert.ok(!('error' in await comment(prisma, s, task.id, 'Also cover the mobile app.')))
  await drainTicketJobs(prisma, s, seen)

  // Two comments, one pending kickoff listing both in order, one wake counted.
  const pendings = await prisma.runThreadPendingMessage.findMany({ where: { threadId: work.threadId } })
  const ticketWorkPendings = pendings.filter((row) =>
    AuthorizedActionContextSchema.parse(row.actorContext).actionContext.purpose === 'ticket.work')
  assert.equal(ticketWorkPendings.length, 1)
  const folded = await prisma.message.findUniqueOrThrow({ where: { id: ticketWorkPendings[0]!.messageId } })
  assert.ok(folded.content.includes([
    'Since your last run, in order (2 changes):',
    '1. ticket_commented: Ondrej commented:',
    '> Please use the new redirect URL.',
    '2. ticket_commented: Ondrej commented:',
    '> Also cover the mobile app.',
  ].join('\n')))
  assert.match(folded.content, /this is wake 2 of 30/)
  assert.equal((await workOf(prisma, s, task.id)).wakeCount, 2)
  // Every wake still has its own row in the thread.
  assert.deepEqual((await threadRows(prisma, work.threadId)).map((row) => row.reason), ['pickup', 'ticket_commented', 'ticket_commented'])
  const comments = await prisma.taskEvent.findMany({ where: { taskId: task.id, eventType: 'comment_added' } })
  for (const event of comments) {
    assert.equal((await deliveryFor(prisma, s, `ticket:${s.triggerId}:${event.id}`)).status, 'delivered')
  }

  // Drain until nothing is left: no ticket.work run ever carries the person's message.
  for (let index = 0; index < 4; index += 1) {
    await finishRuns(prisma, work.threadId)
    await drainPendingThreadMessages(prisma, { agentId: s.agentId, threadId: work.threadId })
  }
  const runs = await prisma.run.findMany({ where: { threadId: work.threadId } })
  const jobs = await Promise.all(runs.map((run) => runJobFor(prisma, run.id)))
  const ticketWorkJobs = jobs.filter((job) => job.actorContext.actionContext.purpose === 'ticket.work')
  assert.equal(ticketWorkJobs.length, 2, 'the pickup and the one folded wake')
  for (const job of ticketWorkJobs) {
    assert.ok(!(job.batchMessageIds ?? []).includes(personMessage.id))
    assert.notEqual(job.messageId, personMessage.id)
  }
  assert.deepEqual(ticketWorkJobs.at(-1)?.batchMessageIds, [folded.id])
})

runDatabaseTest('a wake past wakesPerTicket stops the work instead of running it', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma, { wakesPerTicket: 2 })
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()
  const task = await newTask(prisma, s)
  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, seen)
  const work = await workOf(prisma, s, task.id)
  await finishRuns(prisma, work.threadId)
  assert.ok(!('error' in await comment(prisma, s, task.id, 'First follow-up.')))
  await drainTicketJobs(prisma, s, seen)
  await finishRuns(prisma, work.threadId)
  assert.equal(await prisma.run.count({ where: { threadId: work.threadId } }), 2)

  assert.ok(!('error' in await comment(prisma, s, task.id, 'One too many.')))
  await drainTicketJobs(prisma, s, seen)
  const stopped = await workOf(prisma, s, task.id)
  assert.equal(stopped.status, 'failed')
  assert.equal(stopped.stateReason, 'limit_wakes')
  assert.equal(stopped.endedReason, 'limit_wakes')
  assert.equal(await prisma.run.count({ where: { threadId: work.threadId } }), 2, 'no run past the limit')
  const last = await latestEvent(prisma, task.id, 'comment_added')
  const skipped = await deliveryFor(prisma, s, `ticket:${s.triggerId}:${last.id}`)
  assert.equal(skipped.status, 'skipped')
  assert.equal(skipped.errorMessage, 'limit_wakes')
  const ended = TicketWorkActivityPayloadSchema.parse((await latestEvent(prisma, task.id, 'work_ended')).payload)
  assert.deepEqual([ended.status, ended.reason], ['failed', 'limit_wakes'])
  const rows = await threadRows(prisma, work.threadId)
  assert.deepEqual(rows.at(-1) && [rows.at(-1)!.kind, rows.at(-1)!.reason], ['stopped', 'limit_wakes'])
  assert.equal(rows.at(-1)!.content, 'Stopped: 2 wakes used. Move the ticket out of and back into a start-work column to continue')
})

runDatabaseTest('a pickup past startsPerDay is recorded as stopped and starts nothing', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma, { startsPerDay: 1 })
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()
  const first = await newTask(prisma, s, { title: 'First' })
  const second = await newTask(prisma, s, { title: 'Second' })
  await move(prisma, s, first.id, s.columns.inProgress)
  await move(prisma, s, second.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, seen)

  assert.equal((await workOf(prisma, s, first.id)).status, 'active')
  const refused = await workOf(prisma, s, second.id)
  assert.equal(refused.status, 'failed')
  assert.equal(refused.endedReason, 'limit_daily')
  assert.equal(await prisma.run.count({ where: { threadId: refused.threadId } }), 0)
  const entered = await latestEvent(prisma, second.id, 'column_entered')
  const delivery = await deliveryFor(prisma, s, `ticket:${s.triggerId}:${entered.id}`)
  assert.equal(delivery.status, 'skipped')
  assert.equal(delivery.errorMessage, 'limit_starts')
  assert.deepEqual((await threadRows(prisma, refused.threadId)).map((row) => [row.kind, row.reason]), [['stopped', 'limit_daily']])
})

runDatabaseTest('an end column ends the work in the move, the agent\'s own move to Done included', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()

  // The agent moves its own ticket to Done from its ticket.work run.
  const own = await newTask(prisma, s, { title: 'Own move' })
  await move(prisma, s, own.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, seen)
  const work = await workOf(prisma, s, own.id)
  await finishRuns(prisma, work.threadId)
  const context = ticketWorkToolContext(prisma, s, work)
  await runTicketMoveTool(context, { ticketId: own.id, columnId: s.columns.done })
  // Torn down by the move itself, before any dispatch ran.
  const done = await workOf(prisma, s, own.id)
  assert.equal(done.status, 'done')
  assert.equal(done.endedReason, 'left_flow')
  assert.equal(done.endedBy, `agent:${s.agentId}`)
  const moved = await latestEvent(prisma, own.id, 'column_entered')
  assert.equal((moved.payload as { by?: string }).by, `agent:${s.agentId}`)
  assert.deepEqual((moved.payload as { origin?: unknown }).origin, { kind: 'agent', agentId: s.agentId, runId: context.run.id })
  await drainTicketJobs(prisma, s, seen)
  assert.equal((await deliveryFor(prisma, s, `ticket:${s.triggerId}:${moved.id}`)).errorMessage, 'own_agent_event')
  assert.equal(await prisma.run.count({ where: { threadId: work.threadId } }), 1, 'the agent is not woken by its own move')
  const ended = TicketWorkActivityPayloadSchema.parse((await latestEvent(prisma, own.id, 'work_ended')).payload)
  assert.deepEqual([ended.status, ended.reason, ended.by], ['done', 'left_flow', `agent:${s.agentId}`])

  // A person moves another ticket back to Backlog: cancelled, and one
  // machine-less wake only so the agent can comment.
  const back = await newTask(prisma, s, { title: 'Moved back' })
  await move(prisma, s, back.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, seen)
  const backWork = await workOf(prisma, s, back.id)
  await finishRuns(prisma, backWork.threadId)
  await move(prisma, s, back.id, s.columns.backlog)
  assert.equal((await workOf(prisma, s, back.id)).status, 'cancelled')
  await drainTicketJobs(prisma, s, seen)
  const endKickoff = (await kickoffs(prisma, backWork.threadId)).at(-1)
  assert.match(endKickoff?.content ?? '', /ticket_moved: Ondrej moved the ticket from In progress \(in_progress\) to Backlog \(todo\), which ends its work/)
  assert.equal(await prisma.run.count({ where: { threadId: backWork.threadId } }), 2)
})

runDatabaseTest('a review column parks the work; the editor\'s move back resumes the same record in the same thread', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()
  const task = await newTask(prisma, s)
  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, seen)
  const work = await workOf(prisma, s, task.id)
  await finishRuns(prisma, work.threadId)

  await move(prisma, s, task.id, s.columns.review)
  assert.equal((await workOf(prisma, s, task.id)).status, 'parked', 'parked by the move itself')
  await drainTicketJobs(prisma, s, seen)
  await finishRuns(prisma, work.threadId)

  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, seen)
  const resumed = await workOf(prisma, s, task.id)
  assert.equal(resumed.id, work.id)
  assert.equal(resumed.status, 'active')
  assert.equal(await prisma.agentTicketWork.count({ where: { triggerId: s.triggerId, taskId: task.id } }), 1)
  const reentered = await latestEvent(prisma, task.id, 'column_entered')
  const delivery = await deliveryFor(prisma, s, `ticket:${s.triggerId}:${reentered.id}`)
  assert.equal((delivery.payload as { outcome?: string }).outcome, 'reentry')
  assert.deepEqual(
    (await threadRows(prisma, work.threadId)).map((row) => row.reason),
    ['pickup', 'ticket_moved', 'ticket_moved'],
  )
})

runDatabaseTest('a ticket that comes back after its work ended is worked in the same thread', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()
  const task = await newTask(prisma, s)
  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, seen)
  const first = await workOf(prisma, s, task.id)
  await finishRuns(prisma, first.threadId)
  await move(prisma, s, task.id, s.columns.done)
  await drainTicketJobs(prisma, s, seen)
  await finishRuns(prisma, first.threadId)
  assert.equal((await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: first.id } })).status, 'done')

  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, seen)
  const second = await workOf(prisma, s, task.id)
  assert.notEqual(second.id, first.id)
  assert.equal(second.status, 'active')
  assert.equal(second.threadId, first.threadId)
  assert.equal(await prisma.thread.count({ where: { channelId: s.channelId, agentId: s.agentId } }), 1)
})

runDatabaseTest('assignOnPickup: an unassigned ticket goes to the agent, an assigned one keeps its assignee, a token\'s move keeps the mover rule', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })

  const unassigned = await newTask(prisma, s, { title: 'Unassigned' })
  await move(prisma, s, unassigned.id, s.columns.inProgress)
  const toAgent = await prisma.task.findUniqueOrThrow({ where: { id: unassigned.id } })
  assert.deepEqual([toAgent.assigneeAgentId, toAgent.assigneeUserId], [s.agentId, null])

  const assigned = await newTask(prisma, s, { title: 'Already assigned' })
  await assignProjectTask(prisma, {
    taskId: assigned.id, organizationId: s.organizationId, assigneeUserId: s.outsiderId,
    actorContext: s.actorContext, origin: SESSION,
  })
  await move(prisma, s, assigned.id, s.columns.inProgress)
  const kept = await prisma.task.findUniqueOrThrow({ where: { id: assigned.id } })
  assert.deepEqual([kept.assigneeAgentId, kept.assigneeUserId], [null, s.outsiderId])

  const byToken = await newTask(prisma, s, { title: 'Moved by a token' })
  await move(prisma, s, byToken.id, s.columns.inProgress, { kind: 'token', keyId: randomUUID() })
  const mover = await prisma.task.findUniqueOrThrow({ where: { id: byToken.id } })
  assert.deepEqual([mover.assigneeAgentId, mover.assigneeUserId], [null, s.editorId])
  const moverEvent = await latestEvent(prisma, byToken.id, 'assigned')
  assert.equal((moverEvent.payload as { reason?: string }).reason, 'moved_to_in_progress')
})

runDatabaseTest('disabling the trigger ends its live work; deleting one ends it first', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()
  const task = await newTask(prisma, s)
  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, seen)
  const work = await workOf(prisma, s, task.id)

  await updateAgentTrigger(prisma, { organizationId: s.organizationId, triggerId: s.triggerId }, { enabled: false })
  const disabled = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.deepEqual([disabled.status, disabled.endedReason], ['cancelled', 'trigger_disabled'])
  const ended = TicketWorkActivityPayloadSchema.parse((await latestEvent(prisma, task.id, 'work_ended')).payload)
  assert.equal(ended.reason, 'trigger_disabled')

  // A trigger with no delivery history may be deleted; its live record ends
  // first and outlives it, unlinked.
  const other = await prisma.agentTrigger.create({
    data: { agentId: s.agentId, type: 'ticket_changed', enabled: false, config: { boardId: s.boardId } },
  })
  const second = await newTask(prisma, s, { title: 'Held by the deleted trigger' })
  const held = await prisma.agentTicketWork.create({
    data: {
      organizationId: s.organizationId, triggerId: other.id, agentId: s.agentId, taskId: second.id,
      projectId: s.projectId, threadId: work.threadId, status: 'active', startedByUserId: s.editorId,
    },
  })
  assert.equal(await deleteAgentTrigger(prisma, { organizationId: s.organizationId, triggerId: other.id }), true)
  const orphan = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: held.id } })
  assert.deepEqual([orphan.status, orphan.endedReason, orphan.triggerId], ['cancelled', 'trigger_disabled', null])
})
