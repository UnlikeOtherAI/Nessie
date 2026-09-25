import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { Prisma, type PrismaClient } from '@prisma/client'
import { placeTicketWorkOnExecutorInTransaction } from '@nessie/executor-manage'
import { TICKET_WORK_SWEEP_TOPIC } from '@nessie/schemas'

import { bridgeReport, heartbeat, pairKey } from '../../../packages/team-admin/test/standing-policy-binding-fixture.js'
import { runTicketWorkSweep } from '../../src/control/ticket-work-sweep.js'
import { LOCAL, moveTo, pickUp, sessionJobs, ticketOwnerKey, withMachinesWorld } from './ticket-work-machines-fixture.js'
import { runDatabaseTest } from './support.js'

/**
 * What guards the dequeue and the sweeps that drive it, against Postgres (T5;
 * docs/standards/ticket-work-machine-access.md → "The dequeue", "A machine that
 * goes away"): a machine whose newest revision awaits review takes no work and
 * suspends nothing; queued work cancelled for its mover closes its sessions for
 * that reason; a placement reads its policy live only under the policy row's
 * lock; a close that waits for a machine to come back outlives the day's TTL;
 * and a sweep enqueued by an event runs the machine steps alone, enqueued only
 * for work it would act on.
 */

const HOUR = 3_600_000

const recordOf = (prisma: PrismaClient, id: string) => prisma.agentTicketWork.findUniqueOrThrow({ where: { id } })

const sweepKey = (at: Date) => `${TICKET_WORK_SWEEP_TOPIC}:machines:${Math.floor(at.getTime() / 10_000)}`

runDatabaseTest('a machine whose identical new revision awaits review takes no work, and suspends nothing', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const seen = new Set<string>()
    const [minis] = world.machines as [string]
    const holder = await pickUp(prisma, world, 'Holds the machine', seen)
    const waiting = await pickUp(prisma, world, 'Waits', seen)
    const reviewed = await prisma.executorCapabilityRevision.findFirstOrThrow({ where: { executorId: minis, revision: 1 } })
    const descriptor = { ...(reviewed.descriptor as Record<string, unknown>), revision: 2 }
    const proposed = await prisma.executorCapabilityRevision.create({
      data: {
        descriptor: descriptor as Prisma.InputJsonValue, executorId: minis, localPolicyDigest: reviewed.localPolicyDigest,
        // A signed report is active as it lands now; one still awaiting review is only ever an older row.
        reviewStatus: 'pending_review', revision: 2, signature: 'proposed',
      },
    })
    await moveTo(prisma, world, holder.taskId, world.columns.done)
    await runTicketWorkSweep(prisma, LOCAL)
    const policy = await prisma.executorStandingPolicy.findUniqueOrThrow({ where: { id: world.policyId } })
    assert.deepEqual([policy.status, policy.suspendedReason], ['live', null], 'its review settles the policy, not the dequeue')
    assert.deepEqual([(await recordOf(prisma, waiting.work.id)).status], ['queued'], 'and nothing is placed on it meanwhile')

    await prisma.executorCapabilityRevision.update({ where: { id: proposed.id }, data: { reviewStatus: 'active' } })
    await runTicketWorkSweep(prisma, LOCAL)
    const placed = await recordOf(prisma, waiting.work.id)
    assert.deepEqual([placed.status, placed.executorId], ['active', minis])
  })
})

runDatabaseTest('queued work cancelled because its mover lost the board closes its sessions for that reason', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const seen = new Set<string>()
    const [minis] = world.machines as [string]
    const holder = await pickUp(prisma, world, 'Holds the machine', seen)
    const orphan = await pickUp(prisma, world, 'Its mover leaves', seen)
    const sessionId = randomUUID()
    // It worked on the machine before it queued again: its session is still there.
    await prisma.agentTicketWork.update({ where: { id: orphan.work.id }, data: { executorId: minis, sessionIds: [sessionId] } })
    await moveTo(prisma, world, holder.taskId, world.columns.done)
    await prisma.projectMember.deleteMany({ where: { projectId: world.projectId, userId: world.colleagueId } })
    await runTicketWorkSweep(prisma, LOCAL)
    const lost = await recordOf(prisma, orphan.work.id)
    assert.deepEqual([lost.status, lost.stateReason], ['cancelled', 'mover_lost_access'])
    const closes = await prisma.executorCodingSessionCloseRequest.findMany({
      where: { executorId: minis, sessionId }, select: { reason: true },
    })
    assert.deepEqual(closes, [{ reason: 'mover_lost_access' }])
  })
})

runDatabaseTest('a placement reads its policy live only under the policy row, so a suspension in flight wins', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const [minis] = world.machines as [string]
    // Offline at pickup: the ticket queues, and the machine is free when it is back.
    await prisma.executor.update({ where: { id: minis }, data: { status: 'offline' } })
    const ticket = await pickUp(prisma, world, 'Waits for the machine', new Set())
    await prisma.executor.update({ where: { id: minis }, data: { lastSeenAt: new Date(), status: 'online' } })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let suspending!: () => void
    const suspended = new Promise<void>((resolve) => { suspending = resolve })
    const suspension = prisma.$transaction(async (tx) => {
      await tx.executorStandingPolicy.update({
        where: { id: world.policyId }, data: { status: 'suspended', suspendedReason: 'trigger_changed' },
      })
      suspending()
      await gate
    }, { timeout: 20_000 })
    await suspended
    let settled = false
    const placement = prisma.$transaction((tx) => placeTicketWorkOnExecutorInTransaction(tx, {
      executorId: minis, workId: ticket.work.id,
    }), { timeout: 20_000 }).finally(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(settled, false, 'the placement waits for the suspension that holds the policy row')
    release()
    await suspension
    assert.equal(await placement, 'not_live')
    const record = await recordOf(prisma, ticket.work.id)
    assert.deepEqual([record.status, record.executorId], ['queued', null])
  })
})

runDatabaseTest('a close that waits for its machine outlives the day a close request is otherwise kept', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const [minis] = world.machines as [string]
    const ownerKey = ticketOwnerKey(world, { executorId: minis, policyId: world.policyId, taskId: randomUUID() })
    const [reassigned, suspended] = [randomUUID(), randomUUID()]
    const dayAgo = new Date(Date.now() - 25 * HOUR)
    for (const [sessionId, reason] of [[reassigned, 'machine_reassigned'], [suspended, 'policy_suspended']] as const) {
      await prisma.executorCodingSessionCloseRequest.create({ data: { createdAt: dayAgo, executorId: minis, ownerKey, reason, sessionId } })
    }
    // Back after more than a day, both sessions still running there.
    const key = await pairKey(prisma, minis)
    await heartbeat(prisma, {
      executorId: minis, key, localMcp: bridgeReport([reassigned, suspended].map((sessionId) => ({ ownerKey, sessionId }))),
    })
    const rows = await prisma.executorCodingSessionCloseRequest.findMany({
      where: { executorId: minis }, select: { reason: true, resolvedAt: true },
    })
    const open = (reason: string) => rows.find((row) => row.reason === reason)?.resolvedAt === null
    assert.equal(open('policy_suspended'), false, 'a day old: settled, as before')
    assert.equal(open('machine_reassigned'), true, 'it waits until a report shows its session done')
  })
})

runDatabaseTest('an event\'s sweep runs the machine steps alone, and the heartbeat enqueues it only for work it acts on', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const [minis] = world.machines as [string]
    const ticket = await pickUp(prisma, world, 'Waits for its machine', new Set())
    const ownerKey = ticketOwnerKey(world, { executorId: minis, policyId: world.policyId, taskId: ticket.taskId })
    const sessionId = randomUUID()
    await prisma.agentTicketWork.update({ where: { id: ticket.work.id }, data: { sessionIds: [sessionId] } })
    const key = await pairKey(prisma, minis)
    await heartbeat(prisma, { executorId: minis, key, localMcp: bridgeReport([{ ownerKey, sessionId, status: 'working', turn: 1 }]) })
    await heartbeat(prisma, {
      executorId: minis, key, localMcp: bridgeReport([{ ownerKey, sessionId, status: 'waiting_for_input', turn: 1 }]),
    })
    const [lost] = await sessionJobs(prisma, ticket.work.id)
    assert.ok(lost)
    await prisma.queueJob.update({ where: { id: lost.id }, data: { status: 'dead' } })
    await runTicketWorkSweep(prisma, { machinesOnly: true })
    assert.doesNotMatch((await prisma.queueJob.findUniqueOrThrow({ where: { id: lost.id } })).errorMessage ?? '', /recovered/,
      'lost jobs are the minute\'s tick\'s')
    await runTicketWorkSweep(prisma, LOCAL)
    assert.match((await prisma.queueJob.findUniqueOrThrow({ where: { id: lost.id } })).errorMessage ?? '', /recovered/)

    // Work waiting for this machine under a trigger in error: nothing the sweep would do, so no sweep.
    await prisma.agentTicketWork.update({
      where: { id: ticket.work.id }, data: { stateReason: 'machine_offline', status: 'waiting_machine' },
    })
    await prisma.agentTrigger.update({ where: { id: world.triggerId }, data: { status: 'error' } })
    await prisma.queueJob.deleteMany({ where: { topic: TICKET_WORK_SWEEP_TOPIC, idempotencyKey: { startsWith: `${TICKET_WORK_SWEEP_TOPIC}:machines:` } } })
    const quiet = new Date()
    await heartbeat(prisma, { executorId: minis, key, now: quiet })
    assert.equal(await prisma.queueJob.count({ where: { idempotencyKey: sweepKey(quiet) } }), 0)
    await prisma.agentTrigger.update({ where: { id: world.triggerId }, data: { status: 'active' } })
    const back = new Date(quiet.getTime() + 1)
    await heartbeat(prisma, { executorId: minis, key, now: back })
    assert.equal(await prisma.queueJob.count({ where: { idempotencyKey: sweepKey(back) } }), 1)
  })
})
