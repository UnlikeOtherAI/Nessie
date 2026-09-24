import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import {
  AGENT_REMINDER_CAPS,
  AGENT_REMINDER_PURPOSE,
  RunExecuteJobPayloadSchema,
  TICKET_WORK_PURPOSE,
  TicketWorkThreadEventSchema,
} from '@nessie/schemas'

import { sweepDueAgentReminders } from '../../src/control/agent-reminder-fire.js'
import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { executeBuiltinTool } from '../../src/run/tools.js'
import { runDatabaseTest } from './support.js'
import {
  drainTicketJobs,
  finishRuns,
  move,
  newTask,
  seedTicketWork,
  ticketWorkToolContext,
  type TicketWorkSeed,
} from './ticket-work-fixture.js'

// `check_back_in` against Postgres (docs/standards/ticket-work.md →
// "Reminders, the quiet wake and the sweep"): the tool's range and coercion,
// one pending reminder per work record, a reminder that fires as the record's
// own `ticket.work` wake and ends with it — and outside ticket work, a wake of
// the agent as itself that never re-arms the person who was talking, refused
// where it could, and capped.

const startWork = async (prisma: PrismaClient, s: TicketWorkSeed) => {
  const task = await newTask(prisma, s)
  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, new Set())
  const work = await prisma.agentTicketWork.findFirstOrThrow({ where: { triggerId: s.triggerId, taskId: task.id } })
  await finishRuns(prisma, work.threadId)
  return { task, work }
}

const pendingOf = (prisma: PrismaClient, where: { workId?: string; threadId?: string }) =>
  prisma.agentReminder.findMany({ where: { ...where, status: 'pending' } })

/** A tool context whose run is a real row, as the reminder names the run that set it. */
const onRealRun = async (
  prisma: PrismaClient,
  context: BuiltinToolRuntimeContext,
): Promise<BuiltinToolRuntimeContext> => {
  const run = await prisma.run.create({
    data: { agentId: context.agentId, threadId: context.run.threadId, status: 'completed' },
  })
  return { ...context, run: { ...context.run, id: run.id } }
}

/** Make a reminder due now, without waiting for it. */
const dueNow = (prisma: PrismaClient, id: string) =>
  prisma.agentReminder.update({ where: { id }, data: { dueAt: new Date(Date.now() - 1_000) } })

runDatabaseTest('check_back_in takes "15" as 15, refuses what is out of range with the range, and replaces the ticket\'s reminder', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const { work } = await startWork(prisma, s)
  const context = await onRealRun(prisma, ticketWorkToolContext(prisma, s, work))

  const before = Date.now()
  const set = await executeBuiltinTool('check_back_in', { minutes: '15', note: 'waiting for CI' }, context)
  assert.equal(set.success, true, set.output)
  assert.match(set.output, /Reminder set \| reminderId=/)
  const [first] = await pendingOf(prisma, { workId: work.id })
  assert.ok(first)
  assert.equal(first.threadId, work.threadId)
  assert.equal(first.createdByRunId, context.run.id)
  const minutes = (first.dueAt.getTime() - before) / 60_000
  assert.ok(minutes > 14.9 && minutes < 15.1, `due in 15 minutes, not ${minutes}`)

  for (const minutes of ['3', 4, 1441, '15.5', 'soon']) {
    const refused = await executeBuiltinTool('check_back_in', { minutes, note: 'waiting' }, context)
    assert.equal(refused.success, false, `minutes ${JSON.stringify(minutes)}`)
    assert.match(refused.output, /a whole number from 5 to 1440/, `minutes ${JSON.stringify(minutes)}`)
  }

  const replaced = await executeBuiltinTool('check_back_in', { minutes: 30, note: 'waiting for review' }, context)
  assert.equal(replaced.success, true, replaced.output)
  assert.match(replaced.output, /replaces this ticket's earlier pending reminder/)
  const pending = await pendingOf(prisma, { workId: work.id })
  assert.deepEqual(pending.map((row) => row.note), ['waiting for review'])
  const old = await prisma.agentReminder.findUniqueOrThrow({ where: { id: first.id } })
  assert.deepEqual([old.status, old.cancelledReason], ['cancelled', 'replaced'])
})

runDatabaseTest('a ticket reminder fires as the record\'s own ticket.work wake, counted, and ends with the record', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const { task, work } = await startWork(prisma, s)
  const context = await onRealRun(prisma, ticketWorkToolContext(prisma, s, work))
  assert.equal((await executeBuiltinTool('check_back_in', { minutes: 5, note: 'waiting for CI' }, context)).success, true)
  const [reminder] = await pendingOf(prisma, { workId: work.id })
  await dueNow(prisma, reminder!.id)

  await sweepDueAgentReminders(prisma, { limit: 20 })
  // A second tick finds nothing left to fire: the claim was one.
  await sweepDueAgentReminders(prisma, { limit: 20 })

  const fired = await prisma.agentReminder.findUniqueOrThrow({ where: { id: reminder!.id } })
  assert.equal(fired.status, 'fired')
  const delivery = await prisma.agentTriggerDelivery.findUniqueOrThrow({
    where: { triggerId_dedupeKey: { triggerId: s.triggerId, dedupeKey: `reminder:${reminder!.id}` } },
  })
  assert.equal(delivery.status, 'delivered')
  assert.equal(delivery.source, 'reminder')
  const after = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.equal(after.wakeCount, 2, 'the reminder counts against wakesPerTicket')
  assert.equal(after.lastWakeReason, 'reminder')

  // Woken as the agent, as a ticket.work run of this record, with nobody behind it.
  const run = await prisma.run.findFirstOrThrow({ where: { threadId: work.threadId, status: 'pending' } })
  const job = await prisma.queueJob.findFirstOrThrow({
    where: { topic: 'run.execute', payload: { path: ['runId'], equals: run.id } },
  })
  const payload = RunExecuteJobPayloadSchema.parse(job.payload)
  assert.equal(payload.actorContext.actor.actorType, 'agent')
  assert.equal(payload.actorContext.actionContext.purpose, TICKET_WORK_PURPOSE)
  assert.equal(payload.actorContext.actionContext.ticketWorkId, work.id)
  assert.equal(payload.actorContext.actionContext.effectiveUserId, undefined)
  assert.notEqual(payload.interactive, true, 'nobody is at the keyboard')
  const kickoff = await prisma.message.findUniqueOrThrow({ where: { id: run.triggerMessageId! } })
  // The test moved it due at once, so it says so; a real one says its minutes.
  assert.match(
    kickoff.content,
    /^## Why you were woken\nreminder: The reminder you set at \d\d:\d\d UTC to check back in \d+ minutes fired\. Your note: "waiting for CI"/,
  )
  assert.match(kickoff.content, /Pending reminder: none\./)
  const rows = (await prisma.message.findMany({ where: { threadId: work.threadId, role: 'system' } }))
    .flatMap((message) => {
      const event = TicketWorkThreadEventSchema.safeParse((message.metadata as Record<string, unknown> | null)?.ticketWorkEvent)
      return event.success ? [message.content] : []
    })
  assert.ok(rows.includes('Woken: reminder, waiting for CI'), rows.join(' | '))

  // Another reminder, then the ticket leaves the flow: cancelled in the move.
  await finishRuns(prisma, work.threadId)
  assert.equal((await executeBuiltinTool('check_back_in', { minutes: 60, note: 'check the deploy' }, context)).success, true)
  const [second] = await pendingOf(prisma, { workId: work.id })
  await move(prisma, s, task.id, s.columns.done)
  const cancelled = await prisma.agentReminder.findUniqueOrThrow({ where: { id: second!.id } })
  assert.deepEqual([cancelled.status, cancelled.cancelledReason], ['cancelled', 'work_ended'])
  const ended = await executeBuiltinTool('check_back_in', { minutes: 10, note: 'too late' }, context)
  assert.equal(ended.success, false)
  assert.match(ended.output, /work has ended/)
})

/** A shared agent's run in an ordinary room, started by a person who is talking to it. */
const personRunContext = async (
  prisma: PrismaClient,
  s: TicketWorkSeed,
  threadId: string,
  channel: { id: string; systemChannelType?: string | null },
  principalUserId?: string,
): Promise<BuiltinToolRuntimeContext> => onRealRun(prisma, {
  actorContext: {
    actor: { actorId: s.editorId, actorType: 'user', roles: ['member'] },
    actionContext: { effectiveUserId: s.editorId, requestId: randomUUID() },
    tenant: { organizationId: s.organizationId },
  },
  agentId: s.agentId,
  agentKind: 'shared',
  channel: { id: channel.id, organizationId: s.organizationId, projectId: s.projectId, systemChannelType: channel.systemChannelType ?? null },
  consumedSources: createConsumedSourceSink(),
  ledgerIdentity: null,
  prisma,
  realtimeTransport: { publishWs: async () => undefined },
  run: {
    id: randomUUID(), interactive: true, messageId: randomUUID(), threadId,
    ...(principalUserId ? { principalUserId } : {}),
  },
  toolCallId: randomUUID(),
} as unknown as BuiltinToolRuntimeContext)

runDatabaseTest('outside ticket work a reminder wakes the agent as itself, never as the person who asked', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const thread = await prisma.thread.create({ data: { channelId: s.channelId, agentId: s.agentId, title: 'Release' } })
  const context = await personRunContext(prisma, s, thread.id, { id: s.channelId })

  const set = await executeBuiltinTool('check_back_in', { minutes: 20, note: 'see if the release went out' }, context)
  assert.equal(set.success, true, set.output)
  assert.match(set.output, /wake as yourself, with nobody behind the run/)
  const [reminder] = await pendingOf(prisma, { threadId: thread.id })
  assert.equal(reminder?.workId, null)
  await dueNow(prisma, reminder!.id)
  await sweepDueAgentReminders(prisma, { limit: 20 })

  assert.equal((await prisma.agentReminder.findUniqueOrThrow({ where: { id: reminder!.id } })).status, 'fired')
  const run = await prisma.run.findFirstOrThrow({ where: { threadId: thread.id, status: 'pending' } })
  const job = await prisma.queueJob.findFirstOrThrow({
    where: { topic: 'run.execute', payload: { path: ['runId'], equals: run.id } },
  })
  const payload = RunExecuteJobPayloadSchema.parse(job.payload)
  assert.equal(payload.actorContext.actor.actorType, 'agent')
  assert.equal(payload.actorContext.actor.actorId, s.agentId)
  assert.equal(payload.actorContext.actionContext.purpose, AGENT_REMINDER_PURPOSE)
  assert.equal(payload.actorContext.actionContext.effectiveUserId, undefined, 'the person who asked is not re-armed')
  assert.notEqual(payload.interactive, true, 'nobody is at the keyboard')
  const kickoff = await prisma.message.findUniqueOrThrow({ where: { id: run.triggerMessageId! } })
  assert.equal(kickoff.role, 'system')
  assert.match(kickoff.content, /Your note: "see if the release went out"/)
  assert.match(kickoff.content, /Nobody is behind this run/)

  // The agent left the room before its next reminder came due: nobody to wake.
  await prisma.run.updateMany({ where: { threadId: thread.id }, data: { status: 'completed' } })
  assert.equal((await executeBuiltinTool('check_back_in', { minutes: 5, note: 'again' }, context)).success, true)
  const [next] = await pendingOf(prisma, { threadId: thread.id })
  await dueNow(prisma, next!.id)
  await prisma.agentBinding.deleteMany({ where: { agentId: s.agentId, channelId: s.channelId } })
  await sweepDueAgentReminders(prisma, { limit: 20 })
  const undelivered = await prisma.agentReminder.findUniqueOrThrow({ where: { id: next!.id } })
  assert.deepEqual([undelivered.status, undelivered.cancelledReason], ['cancelled', 'undeliverable'])
  assert.equal(await prisma.run.count({ where: { threadId: thread.id, triggerMessageId: { not: null } } }), 1, 'no second run')
})

runDatabaseTest('outside ticket work check_back_in is refused in a system conversation and for a presence, and capped', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })

  // A Personal Assistant's or the Agent Designer's DM: a system conversation.
  const dm = await prisma.channel.create({
    data: {
      label: 'assistant',
      slug: `assistant-${randomUUID()}`,
      type: 'dm',
      visibility: 'private',
      dmKey: `pa:${randomUUID()}`,
      systemChannelType: 'personal_assistant',
      organization: { connect: { id: s.organizationId } },
      project: { connect: { id: s.projectId } },
      team: { connect: { id: s.teamId } },
    },
  })
  await prisma.agentBinding.create({ data: { agentId: s.agentId, channelId: dm.id } })
  const dmThread = await prisma.thread.create({ data: { channelId: dm.id, agentId: s.agentId, title: 'DM' } })
  const inDm = await executeBuiltinTool(
    'check_back_in',
    { minutes: 10, note: 'later' },
    await personRunContext(prisma, s, dmThread.id, { id: dm.id, systemChannelType: 'personal_assistant' }),
  )
  assert.equal(inDm.success, false)
  assert.match(inDm.output, /refused in a direct conversation with the Personal Assistant, the Agent Designer/)

  const thread = await prisma.thread.create({ data: { channelId: s.channelId, agentId: s.agentId, title: 'Room' } })
  const presence = await executeBuiltinTool(
    'check_back_in',
    { minutes: 10, note: 'later' },
    await personRunContext(prisma, s, thread.id, { id: s.channelId }, s.editorId),
  )
  assert.equal(presence.success, false)
  assert.match(presence.output, /while you speak for a person in this room/)
  assert.equal(await prisma.agentReminder.count({ where: { agentId: s.agentId } }), 0, 'nothing was set')

  const context = await personRunContext(prisma, s, thread.id, { id: s.channelId })
  for (let index = 0; index < AGENT_REMINDER_CAPS.pendingPerThread; index += 1) {
    assert.equal((await executeBuiltinTool('check_back_in', { minutes: 10 + index, note: `step ${index}` }, context)).success, true)
  }
  const fourth = await executeBuiltinTool('check_back_in', { minutes: 30, note: 'one more' }, context)
  assert.equal(fourth.success, false)
  assert.match(fourth.output, /already holds 3 of your pending reminders/)

  // The day's cap counts every reminder the agent set today outside ticket
  // work, fired or cancelled too, in any conversation.
  const other = await prisma.thread.create({ data: { channelId: s.channelId, agentId: s.agentId, title: 'Other' } })
  const spent = AGENT_REMINDER_CAPS.perAgentPerDay - AGENT_REMINDER_CAPS.pendingPerThread
  await prisma.agentReminder.createMany({
    data: Array.from({ length: spent }, (_, index) => ({
      agentId: s.agentId, threadId: other.id, dueAt: new Date(), note: `earlier ${index}`,
      status: 'fired', firedAt: new Date(),
    })),
  })
  const overDay = await executeBuiltinTool(
    'check_back_in',
    { minutes: 10, note: 'tomorrow' },
    await personRunContext(prisma, s, other.id, { id: s.channelId }),
  )
  assert.equal(overDay.success, false)
  assert.match(overDay.output, /already set 24 reminders today/)
})
