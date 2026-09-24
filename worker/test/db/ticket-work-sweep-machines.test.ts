import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'
import { executorCodingSessionOwnerKey } from '@nessie/executor-manage'
import {
  ticketWorkCodingSessionContext,
  TRIGGER_TICKET_DISPATCH_TOPIC,
  TriggerTicketDispatchJobPayloadSchema,
  type TaskEventOrigin,
} from '@nessie/schemas'
import { createProjectTask, moveProjectTaskToColumn } from '@nessie/team-admin'

import { bridgeReport } from '../../../packages/team-admin/test/standing-policy-binding-fixture.js'
import {
  seedStandingPolicyWorld,
  type StandingPolicyWorld,
} from '../../../packages/team-admin/test/standing-policy-fixture.js'
import { dispatchTicketEvent } from '../../src/control/ticket-trigger-dispatch.js'
import { runTicketWorkSweep } from '../../src/control/ticket-work-sweep.js'
import { runDatabaseTest } from './support.js'

/**
 * The sweep's machine half against Postgres (docs/standards/ticket-work-machine-access.md
 * → "The sweep's machine half"): a queued ticket takes the machine another
 * ticket freed with a `dequeued` wake; work over its hours that nobody wakes
 * stops, with its sessions' closes; an author the organisation no longer
 * lists loses their machine access; and a quiet wake waits while the
 * ticket's coding session is mid-turn.
 */

const SESSION: TaskEventOrigin = { kind: 'session' }
const LOCAL = { entitlements: { settings: null, uoaConfigured: false } }
const MINUTE = 60_000

type World = StandingPolicyWorld & { minis: string; policyId: string }

const withWorld = async (run: (world: World, prisma: PrismaClient) => Promise<void>) => {
  const prisma = new PrismaClient()
  const world = await seedStandingPolicyWorld(prisma)
  try {
    await prisma.teamMember.create({ data: { role: 'member', teamId: world.teamId, userId: world.authorId } })
    const minis = await world.machine({ label: 'Minis' })
    const prepared = await world.prepare({ executorIds: [minis] })
    await world.confirm(prepared)
    await run({ ...world, minis, policyId: prepared.policyId }, prisma)
  } finally {
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM queue_jobs WHERE payload->>'organizationId' = ${world.organizationId}
         OR payload->'actorContext'->'tenant'->>'organizationId' = ${world.organizationId}`)
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
}

/** A ticket the colleague, a board editor, creates and moves into In progress; its pickup dispatched. */
const pickedUp = async (prisma: PrismaClient, world: World, title: string, seen: Set<string>) => {
  const created = await createProjectTask(prisma, {
    actorContext: world.contextFor(world.colleagueId),
    createdByUserId: world.colleagueId,
    organizationId: world.organizationId,
    origin: SESSION,
    projectId: world.projectId,
    title,
  })
  if ('error' in created) throw new Error(created.error)
  await moveProjectTaskToColumn(prisma, {
    actorId: world.colleagueId, columnId: world.columns.inProgress, organizationId: world.organizationId,
    origin: SESSION, taskId: created.id,
  })
  const jobs = (await prisma.queueJob.findMany({
    where: { payload: { path: ['organizationId'], equals: world.organizationId }, topic: TRIGGER_TICKET_DISPATCH_TOPIC },
    orderBy: { enqueuedAt: 'asc' },
  })).filter((job) => !seen.has(job.id))
  for (const job of jobs) {
    seen.add(job.id)
    await dispatchTicketEvent(prisma, TriggerTicketDispatchJobPayloadSchema.parse(job.payload))
  }
  const work = await prisma.agentTicketWork.findFirstOrThrow({ where: { taskId: created.id, triggerId: world.triggerId } })
  await prisma.run.updateMany({ where: { threadId: work.threadId }, data: { finishedAt: new Date(), status: 'completed' } })
  return { taskId: created.id, work }
}

const recordOf = (prisma: PrismaClient, id: string) => prisma.agentTicketWork.findUniqueOrThrow({ where: { id } })

runDatabaseTest('a queued ticket takes the machine another ticket freed, with a dequeued wake', async () => {
  await withWorld(async (world, prisma) => {
    const seen = new Set<string>()
    const first = await pickedUp(prisma, world, 'Fix login redirect', seen)
    const second = await pickedUp(prisma, world, 'Add dark mode', seen)
    assert.equal(first.work.status, 'active')
    assert.deepEqual([second.work.status, second.work.queuePosition], ['queued', 1])

    // Nothing free yet: the sweep leaves the queue exactly as it was, and writes nothing.
    await runTicketWorkSweep(prisma, LOCAL)
    const still = await recordOf(prisma, second.work.id)
    assert.deepEqual([still.status, still.queuePosition, still.wakeCount], ['queued', 1, second.work.wakeCount])
    assert.equal(await prisma.agentTriggerDelivery.count({ where: { source: 'dequeue', triggerId: world.triggerId } }), 0)

    // The first ticket's move to Done frees the machine; the sweep places the queued one on it.
    await moveProjectTaskToColumn(prisma, {
      actorId: world.colleagueId, columnId: world.columns.done, organizationId: world.organizationId,
      origin: SESSION, taskId: first.taskId,
    })
    await runTicketWorkSweep(prisma, LOCAL)
    const placed = await recordOf(prisma, second.work.id)
    assert.deepEqual(
      [placed.status, placed.stateReason, placed.executorId, placed.queuePosition, placed.lastWakeReason],
      ['active', null, world.minis, null, 'dequeued'],
    )
    assert.equal(placed.wakeCount, second.work.wakeCount + 1)
    assert.ok(placed.clockStartedAt, 'its hours clock runs from here')
    const delivery = await prisma.agentTriggerDelivery.findFirstOrThrow({
      where: { source: 'dequeue', triggerId: world.triggerId },
    })
    assert.equal(delivery.status, 'delivered')
    assert.deepEqual((delivery.payload as { eventType: string; wakeReason: string }).wakeReason, 'dequeued')
    const resumed = await prisma.taskEvent.findFirstOrThrow({ where: { eventType: 'work_resumed', taskId: second.taskId } })
    assert.equal((resumed.payload as { status: string }).status, 'active')
    const kickoff = await prisma.message.findFirstOrThrow({
      where: { threadId: placed.threadId, metadata: { path: ['ticketWorkKickoff', 'workId'], equals: placed.id } },
      orderBy: { createdAt: 'desc' },
    })
    assert.match(kickoff.content, /^## Why you were woken\ndequeued: A machine is free, so this ticket's queued work starts now/)
    assert.match(kickoff.content, /you are bound to it\./)
    const row = await prisma.message.findFirstOrThrow({
      where: { threadId: placed.threadId, metadata: { path: ['ticketWorkEvent', 'reason'], equals: 'dequeued' } },
    })
    assert.equal(row.content, 'Woken: a machine is free; you are bound to it')
    assert.doesNotMatch(kickoff.content, /Minis/, 'the project never reads the machine\'s name')

    // A second sweep finds nothing queued and starts nothing twice.
    await runTicketWorkSweep(prisma, LOCAL)
    assert.equal(await prisma.agentTriggerDelivery.count({ where: { source: 'dequeue', triggerId: world.triggerId } }), 1)
  })
})

runDatabaseTest('work past its hours that nobody wakes stops, with its sessions\' closes', async () => {
  await withWorld(async (world, prisma) => {
    const { work } = await pickedUp(prisma, world, 'Fix login redirect', new Set())
    const sessionId = randomUUID()
    // The hours clock has run for five hours of the policy's four; nothing woke it since.
    await prisma.agentTicketWork.update({
      where: { id: work.id },
      data: { activeMs: 0n, clockStartedAt: new Date(Date.now() - 5 * 60 * MINUTE), sessionIds: [sessionId] },
    })
    await runTicketWorkSweep(prisma, LOCAL)
    const stopped = await recordOf(prisma, work.id)
    assert.deepEqual([stopped.status, stopped.stateReason], ['failed', 'limit_hours'])
    const close = await prisma.executorCodingSessionCloseRequest.findFirstOrThrow({ where: { sessionId } })
    assert.deepEqual([close.executorId, close.reason], [world.minis, 'work_limit'])
    const row = await prisma.message.findFirstOrThrow({
      where: { threadId: work.threadId, metadata: { path: ['ticketWorkEvent', 'kind'], equals: 'stopped' } },
    })
    assert.match(row.content, /^Stopped: 4 hours of work used\./)
  })
})

runDatabaseTest('an author the organisation no longer lists loses their machine access at the sweep', async () => {
  await withWorld(async (world, prisma) => {
    const { work } = await pickedUp(prisma, world, 'Fix login redirect', new Set())
    const sessionId = randomUUID()
    await prisma.agentTicketWork.update({ where: { id: work.id }, data: { sessionIds: [sessionId] } })
    // Still listed: nothing ends.
    await runTicketWorkSweep(prisma, LOCAL)
    assert.equal((await prisma.executorStandingPolicy.findUniqueOrThrow({ where: { id: world.policyId } })).status, 'live')

    // Gone from the organisation, with no removal feed to say so: the sweep asks, and ends it.
    await prisma.organizationMember.updateMany({
      where: { organizationId: world.organizationId, userId: world.authorId }, data: { deactivatedAt: new Date() },
    })
    await runTicketWorkSweep(prisma, LOCAL)
    const policy = await prisma.executorStandingPolicy.findUniqueOrThrow({ where: { id: world.policyId } })
    assert.deepEqual([policy.status, policy.endedReason, policy.endedByUserId], ['ended', 'author_left_organization', null])
    const ended = await recordOf(prisma, work.id)
    assert.deepEqual([ended.status, ended.stateReason], ['cancelled', 'machine_access_ended'])
    const close = await prisma.executorCodingSessionCloseRequest.findFirstOrThrow({ where: { sessionId } })
    assert.equal(close.reason, 'policy_ended')
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'executor.policy.ended', resourceId: world.policyId },
    })
    assert.equal((audit.metadata as { reason: string }).reason, 'author_left_organization')
  })
})

runDatabaseTest('a quiet wake waits while the ticket\'s own coding session is mid-turn', async () => {
  await withWorld(async (world, prisma) => {
    const { taskId, work } = await pickedUp(prisma, world, 'Fix login redirect', new Set())
    const ownerKey = executorCodingSessionOwnerKey(world.minis, {
      actorUserId: world.authorId, agentId: world.agentId, contextId: ticketWorkCodingSessionContext(world.policyId, taskId),
    })
    const report = (status: string) => prisma.executor.update({
      where: { id: world.minis },
      data: { lastSeenAt: new Date(), localMcp: bridgeReport([{ ownerKey, sessionId: randomUUID(), status }]) as never },
    })
    const quiet = () => prisma.agentTriggerDelivery.count({ where: { source: 'quiet', triggerId: world.triggerId } })
    await prisma.agentTicketWork.update({ where: { id: work.id }, data: { lastWakeAt: new Date(Date.now() - 31 * MINUTE) } })
    await prisma.run.updateMany({ where: { threadId: work.threadId }, data: { finishedAt: new Date(Date.now() - 31 * MINUTE) } })

    await report('working')
    await runTicketWorkSweep(prisma, LOCAL)
    assert.equal(await quiet(), 0, 'the coding agent is working: nothing to check in on')

    await report('waiting_for_input')
    await runTicketWorkSweep(prisma, LOCAL)
    assert.equal(await quiet(), 1)
    assert.equal((await recordOf(prisma, work.id)).lastWakeReason, 'quiet')
  })
})
