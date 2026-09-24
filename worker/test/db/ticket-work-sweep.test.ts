import assert from 'node:assert/strict'

import { Prisma, PrismaClient } from '@prisma/client'
import {
  TICKET_WORK_SWEEP_TOPIC,
  TicketWorkActivityPayloadSchema,
  TicketWorkThreadEventSchema,
  TRIGGER_TICKET_DISPATCH_TOPIC,
} from '@nessie/schemas'
import { createTaskComment } from '@nessie/team-admin'

import { enqueueTicketWorkSweep, runTicketWorkSweep } from '../../src/control/ticket-work-sweep.js'
import { reattemptTicketWorkDelivery } from '../../src/control/ticket-work-retry.js'
import { runTicketCommentAddTool } from '../../src/run/pa-tools/ticket-comments.js'
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

// `ticket-work.sweep` against Postgres (docs/standards/ticket-work.md →
// "Reminders, the quiet wake and the sweep"): the quiet wake comes only to
// active work with nothing scheduled and no open question; an open question
// pauses it and the hours clock until a person answers, which wakes the
// record; a lowered wake limit ends the work it leaves over; and a pickup
// whose dispatch job was lost still starts.

const MINUTE = 60_000

const startWork = async (prisma: PrismaClient, s: TicketWorkSeed, seen: Set<string>) => {
  const task = await newTask(prisma, s)
  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, seen)
  const work = await prisma.agentTicketWork.findFirstOrThrow({ where: { triggerId: s.triggerId, taskId: task.id } })
  await finishRuns(prisma, work.threadId)
  return { task, work }
}

/** Nothing has woken the record for this long. */
const quietFor = (prisma: PrismaClient, workId: string, minutes: number) =>
  prisma.agentTicketWork.update({ where: { id: workId }, data: { lastWakeAt: new Date(Date.now() - minutes * MINUTE) } })

const quietDeliveries = (prisma: PrismaClient, s: TicketWorkSeed) =>
  prisma.agentTriggerDelivery.findMany({ where: { triggerId: s.triggerId, source: 'quiet' } })

const threadRows = async (prisma: PrismaClient, threadId: string) =>
  (await prisma.message.findMany({ where: { threadId, role: 'system' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
    .flatMap((message) => {
      const parsed = TicketWorkThreadEventSchema.safeParse((message.metadata as Record<string, unknown> | null)?.ticketWorkEvent)
      return parsed.success ? [message.content] : []
    })

runDatabaseTest('the quiet wake comes only to active work with nothing scheduled, and counts', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()
  const { task, work } = await startWork(prisma, s, seen)

  // Not yet quiet for the default 30 minutes.
  await quietFor(prisma, work.id, 29)
  await runTicketWorkSweep(prisma)
  assert.equal((await quietDeliveries(prisma, s)).length, 0)

  // A pending reminder is something scheduled.
  await quietFor(prisma, work.id, 31)
  const reminder = await prisma.agentReminder.create({
    data: { agentId: s.agentId, threadId: work.threadId, workId: work.id, dueAt: new Date(Date.now() + 10 * MINUTE), note: 'CI' },
  })
  await runTicketWorkSweep(prisma)
  assert.equal((await quietDeliveries(prisma, s)).length, 0, 'a reminder is scheduled')
  await prisma.agentReminder.update({ where: { id: reminder.id }, data: { status: 'cancelled', cancelledReason: 'person' } })

  // A run still in flight is not quiet either.
  const running = await prisma.run.create({ data: { agentId: s.agentId, threadId: work.threadId, status: 'running' } })
  await runTicketWorkSweep(prisma)
  assert.equal((await quietDeliveries(prisma, s)).length, 0, 'a run is in flight')
  await prisma.run.update({ where: { id: running.id }, data: { status: 'completed' } })

  // Parked work waits for people: no quiet wake.
  await move(prisma, s, task.id, s.columns.review)
  await drainTicketJobs(prisma, s, seen)
  await finishRuns(prisma, work.threadId)
  await quietFor(prisma, work.id, 31)
  await runTicketWorkSweep(prisma)
  assert.equal((await quietDeliveries(prisma, s)).length, 0, 'parked work gets none')
  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, seen)
  await finishRuns(prisma, work.threadId)
  const resumed = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.equal(resumed.status, 'active')

  await quietFor(prisma, work.id, 31)
  await runTicketWorkSweep(prisma)
  const [quiet] = await quietDeliveries(prisma, s)
  assert.equal(quiet?.status, 'delivered')
  const woken = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.equal(woken.lastWakeReason, 'quiet')
  assert.equal(woken.wakeCount, resumed.wakeCount + 1, 'a quiet wake counts against wakesPerTicket')
  assert.ok((await threadRows(prisma, work.threadId)).includes('Woken: nothing else is scheduled'))
  const kickoff = await prisma.message.findFirstOrThrow({
    where: { threadId: work.threadId, role: 'system', content: { startsWith: '## Why you were woken\nquiet:' } },
  })
  assert.match(kickoff.content, /quiet: Nothing else is scheduled: no wake for 30 minutes/)

  // The next minute's sweep finds it woken just now: one quiet wake, not two.
  await finishRuns(prisma, work.threadId)
  await runTicketWorkSweep(prisma)
  assert.equal((await quietDeliveries(prisma, s)).length, 1)

  // A trigger that turned the quiet wake off never sends one.
  const trigger = await prisma.agentTrigger.findUniqueOrThrow({ where: { id: s.triggerId } })
  await prisma.agentTrigger.update({
    where: { id: s.triggerId },
    data: { config: { ...(trigger.config as Record<string, unknown>), quietWakeMinutes: null } },
  })
  await quietFor(prisma, work.id, 600)
  await runTicketWorkSweep(prisma)
  assert.equal((await quietDeliveries(prisma, s)).length, 1, 'off is off')
})

runDatabaseTest('an open question pauses the quiet wake and the hours clock until a person answers, which wakes the work', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()
  const { task, work } = await startWork(prisma, s, seen)
  const context = ticketWorkToolContext(prisma, s, work)
  // The clock has run for ten minutes.
  await prisma.agentTicketWork.update({
    where: { id: work.id },
    data: { clockStartedAt: new Date(Date.now() - 10 * MINUTE), activeMs: 0n },
  })

  const asked = await runTicketCommentAddTool(context, {
    ticketId: task.id, body: 'Should the redirect keep the query string?', awaitsAnswer: true,
  })
  assert.match(asked.outputPreview, /Marked as a question/)
  const commented = await prisma.taskEvent.findFirstOrThrow({ where: { taskId: task.id, eventType: 'comment_added' } })
  assert.equal((commented.payload as { awaitsAnswer?: boolean }).awaitsAnswer, true)
  const waiting = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.ok(waiting.awaitingAnswerAt, 'the question is open')
  assert.equal(waiting.clockStartedAt, null, 'the hours clock is paused')
  assert.ok(waiting.activeMs >= BigInt(10 * MINUTE - 1_000) && waiting.activeMs < BigInt(11 * MINUTE))

  // Hours of quiet, and still no quiet wake: a person owes the answer.
  await drainTicketJobs(prisma, s, seen)
  await quietFor(prisma, work.id, 240)
  await runTicketWorkSweep(prisma)
  assert.equal((await quietDeliveries(prisma, s)).length, 0)
  const stillWaiting = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.equal(stillWaiting.activeMs, waiting.activeMs, 'no hours were counted while it waited')
  assert.equal(stillWaiting.wakeCount, waiting.wakeCount, 'no wake was spent')

  // A person answers: that wakes the work, closes the question and runs the clock.
  const answered = await createTaskComment(
    prisma,
    { organizationId: s.organizationId, userId: s.editorId, isOrganizationAdmin: false, origin: SESSION },
    { taskId: task.id, body: 'Yes, keep it.' },
  )
  assert.ok(!('error' in answered))
  await drainTicketJobs(prisma, s, seen)
  const after = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.equal(after.lastWakeReason, 'ticket_commented')
  assert.equal(after.wakeCount, waiting.wakeCount + 1)
  assert.equal(after.awaitingAnswerAt, null)
  assert.ok(after.clockStartedAt, 'the hours clock runs again')
  assert.equal(after.activeMs, waiting.activeMs)

  // A later comment of the agent's that asks nothing also closes a question.
  await finishRuns(prisma, work.threadId)
  await runTicketCommentAddTool(context, { ticketId: task.id, body: 'Is staging the right place?', awaitsAnswer: true })
  assert.ok((await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })).awaitingAnswerAt)
  await runTicketCommentAddTool(context, { ticketId: task.id, body: 'Never mind, I found it.' })
  const closed = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.equal(closed.awaitingAnswerAt, null)
  assert.ok(closed.clockStartedAt)
})

runDatabaseTest('the sweep ends work a lowered wake limit left over, with its activity row', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()
  const { task, work } = await startWork(prisma, s, seen)
  await createTaskComment(
    prisma,
    { organizationId: s.organizationId, userId: s.editorId, isOrganizationAdmin: false, origin: SESSION },
    { taskId: task.id, body: 'Also check the mobile app.' },
  )
  await drainTicketJobs(prisma, s, seen)
  await finishRuns(prisma, work.threadId)
  assert.equal((await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })).wakeCount, 2)

  const trigger = await prisma.agentTrigger.findUniqueOrThrow({ where: { id: s.triggerId } })
  const config = trigger.config as Record<string, unknown>
  await prisma.agentTrigger.update({
    where: { id: s.triggerId },
    data: { config: { ...config, limits: { ...(config['limits'] as object), wakesPerTicket: 1 } } },
  })
  await runTicketWorkSweep(prisma)

  const ended = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.deepEqual([ended.status, ended.stateReason, ended.endedBy], ['failed', 'limit_wakes', 'system'])
  const row = await prisma.taskEvent.findFirstOrThrow({ where: { taskId: task.id, eventType: 'work_ended' } })
  const payload = TicketWorkActivityPayloadSchema.parse(row.payload)
  assert.deepEqual([payload.workId, payload.status, payload.reason], [work.id, 'failed', 'limit_wakes'])
  assert.ok((await threadRows(prisma, work.threadId)).some((content) => content.startsWith('Stopped: 2 wakes used.')))
})

runDatabaseTest('a pickup whose dispatch job the queue gave up on is recovered once by the sweep', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const task = await newTask(prisma, s)
  await move(prisma, s, task.id, s.columns.inProgress)
  const entered = await prisma.taskEvent.findFirstOrThrow({ where: { taskId: task.id, eventType: 'column_entered' } })
  // The worker holding the job died at its last attempt.
  await prisma.$executeRaw(Prisma.sql`
    UPDATE queue_jobs SET status = 'dead', error_message = 'lock_expired_at_max_attempts'
    WHERE topic = ${TRIGGER_TICKET_DISPATCH_TOPIC} AND payload->>'taskEventId' = ${entered.id}`)
  assert.equal(await prisma.agentTicketWork.count({ where: { taskId: task.id } }), 0, 'nothing started yet')

  await runTicketWorkSweep(prisma)
  const work = await prisma.agentTicketWork.findFirstOrThrow({ where: { triggerId: s.triggerId, taskId: task.id } })
  assert.equal(work.status, 'active')
  assert.equal(work.startedByUserId, s.editorId)
  const job = await prisma.queueJob.findFirstOrThrow({
    where: { topic: TRIGGER_TICKET_DISPATCH_TOPIC, payload: { path: ['taskEventId'], equals: entered.id } },
  })
  assert.equal(job.status, 'dead')
  assert.equal(job.errorMessage, 'recovered_by_ticket_work_sweep')

  await finishRuns(prisma, work.threadId)
  await runTicketWorkSweep(prisma)
  assert.equal(await prisma.agentTicketWork.count({ where: { taskId: task.id } }), 1)
  assert.equal(await prisma.agentTriggerDelivery.count({ where: { triggerId: s.triggerId, source: 'pickup' } }), 1)
})

runDatabaseTest('the periodic sweep is one job a minute, by its bucket', async (t) => {
  const prisma = new PrismaClient()
  // A minute no real worker will tick in.
  const at = new Date(Date.UTC(2099, 0, 1, 12, 0, 10))
  const buckets = [at, new Date(at.getTime() + MINUTE)].map((date) => String(Math.floor(date.getTime() / MINUTE)))
  const keys = buckets.map((bucket) => `${TICKET_WORK_SWEEP_TOPIC}:${bucket}`)
  t.after(async () => {
    await prisma.queueJob.deleteMany({ where: { idempotencyKey: { in: keys } } })
    await prisma.$disconnect()
  })
  assert.equal(await enqueueTicketWorkSweep(prisma, at), true)
  assert.equal(await enqueueTicketWorkSweep(prisma, new Date(at.getTime() + 40_000)), false, 'the same minute')
  assert.equal(await enqueueTicketWorkSweep(prisma, new Date(at.getTime() + MINUTE)), true, 'the next minute')
  const jobs = await prisma.queueJob.findMany({ where: { idempotencyKey: { in: keys } } })
  assert.deepEqual(jobs.map((job) => (job.payload as { bucket?: string }).bucket).sort(), buckets.sort())
})

runDatabaseTest('a failed quiet wake retried while a question waits is settled, never a spent wake', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()
  const { task, work } = await startWork(prisma, s, seen)
  const failedQuiet = (n: number) => prisma.agentTriggerDelivery.create({
    data: {
      triggerId: s.triggerId, source: 'quiet', status: 'failed', dedupeKey: `quiet:${work.id}:retry-${n}`,
      errorMessage: 'the target channel was busy', nextRetryAt: new Date(),
      payload: { taskId: task.id, eventType: 'quiet', originKind: 'system', outcome: 'follow', wakeReason: 'quiet', workId: work.id },
    },
  })
  const retry = (delivery: { id: string; payload: unknown }) => reattemptTicketWorkDelivery(prisma, {
    organizationId: s.organizationId, payload: delivery.payload, retryCount: 1,
    reuseDeliveryId: delivery.id, triggerId: s.triggerId,
  })

  await prisma.agentTicketWork.update({ where: { id: work.id }, data: { awaitingAnswerAt: new Date() } })
  const asked = await failedQuiet(1)
  await retry(asked)
  const settled = await prisma.agentTriggerDelivery.findUniqueOrThrow({ where: { id: asked.id } })
  assert.deepEqual([settled.status, settled.errorMessage], ['skipped', 'no_longer_applies'])
  assert.equal((await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })).wakeCount, work.wakeCount)

  await prisma.agentTicketWork.update({ where: { id: work.id }, data: { awaitingAnswerAt: null } })
  const quiet = await failedQuiet(2)
  await retry(quiet)
  assert.equal((await prisma.agentTriggerDelivery.findUniqueOrThrow({ where: { id: quiet.id } })).status, 'delivered')
  const woken = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.deepEqual([woken.wakeCount, woken.lastWakeReason], [work.wakeCount + 1, 'quiet'])
})
