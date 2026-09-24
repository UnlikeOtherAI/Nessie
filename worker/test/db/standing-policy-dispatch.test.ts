import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'
import {
  TICKET_WORK_SWEEP_TOPIC,
  TRIGGER_TICKET_DISPATCH_TOPIC,
  TriggerTicketDispatchJobPayloadSchema,
  type TaskEventOrigin,
} from '@nessie/schemas'
import { createProjectTask, moveProjectTaskToColumn } from '@nessie/team-admin'

import {
  seedStandingPolicyWorld,
  type StandingPolicyWorld,
} from '../../../packages/team-admin/test/standing-policy-fixture.js'
import { dispatchTicketEvent } from '../../src/control/ticket-trigger-dispatch.js'
import { runDatabaseTest } from './support.js'

/**
 * The pool queue's assignment, at dispatch, against Postgres
 * (docs/plans/2026-09-23-ticket-driven-agents/ticket-work.md → "The pool
 * queue"; docs/standards/ticket-work-machine-access.md): two pickups get the
 * two machines, a third is queued with one short unbound `queued` wake that
 * names no machine; a pinned machine offline at wake time starts no run and
 * the work waits for it; a ticket leaving the flow closes its sessions by id;
 * and a wake past a limit stops the work instead.
 */

const SESSION: TaskEventOrigin = { kind: 'session' }

type World = StandingPolicyWorld & { minis: string; studio: string; policyId: string }

const withWorld = async (run: (world: World, prisma: PrismaClient) => Promise<void>) => {
  const prisma = new PrismaClient()
  const world = await seedStandingPolicyWorld(prisma)
  try {
    await prisma.teamMember.create({ data: { role: 'member', teamId: world.teamId, userId: world.authorId } })
    const minis = await world.machine({ label: 'Minis' })
    const studio = await world.machine({ label: 'Studio' })
    const prepared = await world.prepare({ executorIds: [minis, studio] })
    await world.confirm(prepared)
    await run({ ...world, minis, policyId: prepared.policyId, studio }, prisma)
  } finally {
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM queue_jobs WHERE payload->>'organizationId' = ${world.organizationId}
         OR payload->'actorContext'->'tenant'->>'organizationId' = ${world.organizationId}`)
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
}

/** A ticket in the backlog, created and moved by the colleague, a board editor. */
const ticket = async (prisma: PrismaClient, world: World, title: string) => {
  const created = await createProjectTask(prisma, {
    actorContext: world.contextFor(world.colleagueId),
    createdByUserId: world.colleagueId,
    organizationId: world.organizationId,
    origin: SESSION,
    projectId: world.projectId,
    title,
  })
  if ('error' in created) throw new Error(created.error)
  return created.id
}

const moveTo = (prisma: PrismaClient, world: World, taskId: string, columnId: string) =>
  moveProjectTaskToColumn(prisma, {
    actorId: world.colleagueId, columnId, organizationId: world.organizationId, origin: SESSION, taskId,
  })

/** Run every dispatch job the moves enqueued and this suite has not run yet. */
const drain = async (prisma: PrismaClient, world: World, seen: Set<string>, concurrently = false) => {
  const jobs = (await prisma.queueJob.findMany({
    where: { payload: { path: ['organizationId'], equals: world.organizationId }, topic: TRIGGER_TICKET_DISPATCH_TOPIC },
    orderBy: { enqueuedAt: 'asc' },
  })).filter((job) => !seen.has(job.id))
  for (const job of jobs) seen.add(job.id)
  const run = (job: (typeof jobs)[number]) => dispatchTicketEvent(prisma, TriggerTicketDispatchJobPayloadSchema.parse(job.payload))
  if (concurrently) await Promise.all(jobs.map(run))
  else for (const job of jobs) await run(job)
}

/** A comment by the colleague and its event, as the comment route writes them. */
const comment = async (prisma: PrismaClient, world: World, taskId: string) => {
  const row = await prisma.taskComment.create({
    data: { authorUserId: world.colleagueId, body: 'One more thing.', organizationId: world.organizationId, taskId },
  })
  return prisma.taskEvent.create({
    data: { eventType: 'comment_added', payload: { by: world.colleagueId, commentId: row.id, origin: SESSION }, taskId },
  })
}

const workOf = (prisma: PrismaClient, world: World, taskId: string) =>
  prisma.agentTicketWork.findFirstOrThrow({ where: { taskId, triggerId: world.triggerId }, orderBy: { createdAt: 'desc' } })

const kickoffOf = async (prisma: PrismaClient, threadId: string) => (await prisma.message.findFirstOrThrow({
  where: { threadId, metadata: { path: ['ticketWorkKickoff', 'workId'], not: Prisma.AnyNull } },
  orderBy: { createdAt: 'desc' },
})).content

runDatabaseTest('two pickups get the two machines, and a third is queued with one short wake', async () => {
  await withWorld(async (world, prisma) => {
    const seen = new Set<string>()
    const [first, second, third] = [
      await ticket(prisma, world, 'Fix login redirect'),
      await ticket(prisma, world, 'Add dark mode'),
      await ticket(prisma, world, 'Speed up search'),
    ]
    // The first two picked up at the same moment: the pool's locks give each its own machine.
    await moveTo(prisma, world, first, world.columns.inProgress)
    await moveTo(prisma, world, second, world.columns.inProgress)
    await drain(prisma, world, seen, true)
    const [one, two] = [await workOf(prisma, world, first), await workOf(prisma, world, second)]
    assert.deepEqual([one.status, two.status], ['active', 'active'])
    assert.deepEqual(new Set([one.executorId, two.executorId]), new Set([world.minis, world.studio]))
    assert.deepEqual([one.policyId, two.policyId], [world.policyId, world.policyId])

    await moveTo(prisma, world, third, world.columns.inProgress)
    await drain(prisma, world, seen)
    const queued = await workOf(prisma, world, third)
    assert.deepEqual([queued.status, queued.stateReason, queued.executorId, queued.queuePosition],
      ['queued', 'queued_no_free_machine', null, 1])
    assert.equal(queued.lastWakeReason, 'queued')
    const kickoff = await kickoffOf(prisma, queued.threadId)
    assert.match(kickoff, /^## Why you were woken\nqueued: Colleague moved the ticket/)
    assert.match(kickoff, /all 2 machines are busy with other tickets: it is queued at position 1/)
    assert.match(kickoff, /Machine: none yet — the work is queued at position 1, because every machine is busy/)
    assert.doesNotMatch(kickoff, /Minis|Studio/, 'no machine is named to the project')
    const history = await prisma.taskEvent.findMany({
      where: { taskId: third, eventType: { in: ['work_started', 'work_queued'] } }, orderBy: { createdAt: 'asc' },
      select: { eventType: true, payload: true },
    })
    assert.deepEqual(history.map((row) => [row.eventType, (row.payload as { reason: string }).reason]),
      [['work_started', 'queued_no_free_machine'], ['work_queued', 'queued_no_free_machine']])
    const audits = await prisma.auditLog.findMany({
      where: { organizationId: world.organizationId, action: { in: ['ticket.work.started', 'ticket.work.queued'] } },
      select: { action: true },
    })
    assert.deepEqual(audits.map((row) => row.action).sort(),
      ['ticket.work.queued', 'ticket.work.started', 'ticket.work.started', 'ticket.work.started'])

    // The first ticket leaving the flow frees its machine, closes its sessions by id, and wakes the dispatcher.
    const sessionId = randomUUID()
    await prisma.agentTicketWork.update({
      where: { id: one.id }, data: { lastPrState: 'MERGED', sessionIds: [sessionId] },
    })
    await moveTo(prisma, world, first, world.columns.done)
    const ended = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: one.id } })
    assert.deepEqual([ended.status, ended.stateReason], ['done', 'merged'])
    const close = await prisma.executorCodingSessionCloseRequest.findFirstOrThrow({ where: { sessionId } })
    assert.deepEqual([close.executorId, close.reason], [one.executorId, 'ticket_left_flow'])
    assert.ok(await prisma.queueJob.count({ where: { topic: TICKET_WORK_SWEEP_TOPIC } }) > 0)
  })
})

runDatabaseTest('a pinned machine offline at wake time starts no run: the work waits for it', async () => {
  await withWorld(async (world, prisma) => {
    const seen = new Set<string>()
    const taskId = await ticket(prisma, world, 'Fix login redirect')
    await moveTo(prisma, world, taskId, world.columns.inProgress)
    await drain(prisma, world, seen)
    const work = await workOf(prisma, world, taskId)
    assert.equal(work.status, 'active')
    await prisma.run.updateMany({ where: { threadId: work.threadId }, data: { status: 'completed' } })
    const runs = await prisma.run.count({ where: { threadId: work.threadId } })
    await prisma.executor.update({ where: { id: work.executorId! }, data: { status: 'offline' } })
    const commented = await comment(prisma, world, taskId)
    await dispatchTicketEvent(prisma, { organizationId: world.organizationId, taskEventId: commented.id })
    const waiting = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
    assert.deepEqual([waiting.status, waiting.stateReason, waiting.executorId],
      ['waiting_machine', 'machine_offline', work.executorId], 'it keeps its machine\'s slot')
    assert.equal(await prisma.run.count({ where: { threadId: work.threadId } }), runs, 'no model run')
    const paused = await prisma.taskEvent.findFirstOrThrow({ where: { eventType: 'work_paused', taskId } })
    assert.equal((paused.payload as { reason: string }).reason, 'machine_offline')
  })
})

runDatabaseTest('a wake past the policy\'s spend stops the work instead of waking it', async () => {
  await withWorld(async (world, prisma) => {
    const seen = new Set<string>()
    const taskId = await ticket(prisma, world, 'Fix login redirect')
    await moveTo(prisma, world, taskId, world.columns.inProgress)
    await drain(prisma, world, seen)
    const work = await workOf(prisma, world, taskId)
    await prisma.agentTicketWork.update({ where: { id: work.id }, data: { costUsd: 21 } })
    const commented = await comment(prisma, world, taskId)
    await dispatchTicketEvent(prisma, { organizationId: world.organizationId, taskEventId: commented.id })
    const stopped = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
    assert.deepEqual([stopped.status, stopped.stateReason], ['failed', 'limit_cost'])
    const delivery = await prisma.agentTriggerDelivery.findFirstOrThrow({
      where: { dedupeKey: `ticket:${world.triggerId}:${commented.id}` },
    })
    assert.deepEqual([delivery.status, (delivery.payload as { skipReason?: string }).skipReason], ['skipped', 'limit_cost'])
  })
})
