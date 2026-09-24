import assert from 'node:assert/strict'

import { PrismaClient } from '@prisma/client'
import { assignProjectTask, createTaskComment } from '@nessie/team-admin'

import { runTicketWorkSweep } from '../../src/control/ticket-work-sweep.js'
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

// An open question never switches the safety net off for good
// (docs/standards/ticket-work.md → "Reminders, the quiet wake and the
// sweep"): any comment but an agent's answers it in its own transaction, a
// board editor's answer wakes the work even when its trigger does not follow
// comments, and anyone else's answer brings the quiet wake back.

const MINUTE = 60_000

const startWork = async (prisma: PrismaClient, s: TicketWorkSeed, seen: Set<string>) => {
  const task = await newTask(prisma, s)
  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, seen)
  const work = await prisma.agentTicketWork.findFirstOrThrow({ where: { triggerId: s.triggerId, taskId: task.id } })
  await finishRuns(prisma, work.threadId)
  return { task, work }
}

const ask = async (prisma: PrismaClient, s: TicketWorkSeed, work: { id: string; threadId: string }, taskId: string) => {
  await runTicketCommentAddTool(ticketWorkToolContext(prisma, s, work), {
    ticketId: taskId, body: 'Should the redirect keep the query string?', awaitsAnswer: true,
  })
  const asked = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.ok(asked.awaitingAnswerAt, 'the question is open')
  assert.equal(asked.clockStartedAt, null, 'and the clock paused')
  return asked
}

const commentAs = (prisma: PrismaClient, s: TicketWorkSeed, taskId: string, userId: string, body: string) =>
  createTaskComment(
    prisma,
    { organizationId: s.organizationId, userId, isOrganizationAdmin: false, origin: SESSION },
    { taskId, body },
  )

runDatabaseTest('a board editor\'s answer wakes the work even when its trigger does not follow comments', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma, { followKinds: ['moved'], machineAccess: true })
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()
  const { task, work } = await startWork(prisma, s, seen)
  const asked = await ask(prisma, s, work, task.id)
  await drainTicketJobs(prisma, s, seen)

  // An ordinary comment of the editor's before the question — the trigger
  // follows moves only — would wake nothing; this one answers.
  assert.ok(!('error' in await commentAs(prisma, s, task.id, s.editorId, 'Yes, keep it.')))
  const answer = await prisma.taskEvent.findFirstOrThrow({
    where: {
      taskId: task.id,
      eventType: 'comment_added',
      payload: { path: ['answeredWorkIds'], array_contains: [work.id] },
    },
  })
  const closed = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.equal(closed.awaitingAnswerAt, null, 'the answer closed the question in its own transaction')
  assert.ok(closed.clockStartedAt, 'and the clock runs again')

  await drainTicketJobs(prisma, s, seen)
  const woken = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.equal(woken.lastWakeReason, 'ticket_commented')
  assert.equal(woken.wakeCount, asked.wakeCount + 1)
  const delivery = await prisma.agentTriggerDelivery.findUniqueOrThrow({
    where: { triggerId_dedupeKey: { triggerId: s.triggerId, dedupeKey: `ticket:${s.triggerId}:${answer.id}` } },
  })
  assert.equal(delivery.status, 'delivered')

  // With no question open, the same trigger ignores a comment again.
  await finishRuns(prisma, work.threadId)
  await commentAs(prisma, s, task.id, s.editorId, 'One more thing.')
  await drainTicketJobs(prisma, s, seen)
  assert.equal((await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })).wakeCount, woken.wakeCount)
})

runDatabaseTest('an answer from someone who cannot edit the board wakes nothing but brings the quiet wake back', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma, { machineAccess: true })
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const seen = new Set<string>()
  const { task, work } = await startWork(prisma, s, seen)
  // The outsider reaches the ticket as its assignee, but is no project member.
  await assignProjectTask(prisma, {
    taskId: task.id, organizationId: s.organizationId, assigneeUserId: s.outsiderId,
    actorContext: s.actorContext, origin: SESSION,
  })
  const asked = await ask(prisma, s, work, task.id)
  await drainTicketJobs(prisma, s, seen)

  assert.ok(!('error' in await commentAs(prisma, s, task.id, s.outsiderId, 'I reported it: keep the query string.')))
  await drainTicketJobs(prisma, s, seen)
  const after = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.equal(after.awaitingAnswerAt, null, 'the reply closed the question')
  assert.ok(after.clockStartedAt)
  assert.equal(after.wakeCount, asked.wakeCount, 'but woke nothing: the origin rule holds')

  // Quiet since then, so the safety net wakes it to read the reply.
  await prisma.agentTicketWork.update({
    where: { id: work.id }, data: { lastWakeAt: new Date(Date.now() - 31 * MINUTE) },
  })
  await prisma.run.updateMany({
    where: { threadId: work.threadId }, data: { finishedAt: new Date(Date.now() - 31 * MINUTE) },
  })
  await runTicketWorkSweep(prisma)
  const quiet = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
  assert.equal(quiet.lastWakeReason, 'quiet')
  assert.equal(quiet.wakeCount, asked.wakeCount + 1)
})
