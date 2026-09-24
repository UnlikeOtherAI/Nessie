import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import { TICKET_WORK_SWEEP_TOPIC } from '@nessie/schemas'
import { loadExecutorHoldingTicket, loadTaskTicketWork, loadTriggerMachineAccess } from '@nessie/team-admin'

import { bridgeReport, heartbeat, pairKey } from '../../../packages/team-admin/test/standing-policy-binding-fixture.js'
import { dispatchTicketEvent } from '../../src/control/ticket-trigger-dispatch.js'
import { runTicketWorkSweep } from '../../src/control/ticket-work-sweep.js'
import {
  LOCAL,
  MINUTE,
  SESSION,
  finishRuns,
  pickUp,
  ticketOwnerKey,
  withMachinesWorld,
  type MachinesWorld,
} from './ticket-work-machines-fixture.js'
import { runDatabaseTest } from './support.js'

/**
 * A ticket's machine going away and coming back, against Postgres (T5;
 * docs/standards/ticket-work-machine-access.md → "A machine that goes away"):
 * work whose machine is offline at a wake waits for it and starts no run,
 * later wakes too; its machine's next online heartbeat enqueues the sweep,
 * which resumes it with one `machine_back_online` wake; and past the trigger's
 * `waitingMachineHours` the work is taken off it and queued for another
 * machine of the pool, its sessions there closing when it reconnects. The
 * chip, the Machine access section and the executor page say each state.
 */

const HOUR = 60 * MINUTE

/** A board editor's comment on the ticket, dispatched: a follow wake. */
const comment = async (prisma: PrismaClient, world: MachinesWorld, taskId: string) => {
  const row = await prisma.taskComment.create({
    data: { authorUserId: world.colleagueId, body: 'One more thing.', organizationId: world.organizationId, taskId },
  })
  const event = await prisma.taskEvent.create({
    data: { eventType: 'comment_added', payload: { by: world.colleagueId, commentId: row.id, origin: SESSION }, taskId },
  })
  await dispatchTicketEvent(prisma, { organizationId: world.organizationId, taskEventId: event.id })
  return event.id
}

const recordOf = (prisma: PrismaClient, id: string) => prisma.agentTicketWork.findUniqueOrThrow({ where: { id } })

/** The ticket's work paused because its machine went offline with a wake on the way. */
const pausedOffline = async (prisma: PrismaClient, world: MachinesWorld) => {
  const { taskId, work } = await pickUp(prisma, world, 'Fix login redirect', new Set())
  const machine = work.executorId!
  await prisma.executor.update({
    where: { id: machine }, data: { lastSeenAt: new Date(Date.now() - 5 * MINUTE), status: 'offline' },
  })
  await comment(prisma, world, taskId)
  const waiting = await recordOf(prisma, work.id)
  assert.deepEqual([waiting.status, waiting.stateReason, waiting.executorId], ['waiting_machine', 'machine_offline', machine])
  return { machine, taskId, work: waiting }
}

runDatabaseTest('work waits for its offline machine with no run, and resumes with one wake when it is back', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const { machine, taskId, work } = await pausedOffline(prisma, world)
    const runs = await prisma.run.count({ where: { threadId: work.threadId } })
    // Another person's comment while it is away: skipped, no run.
    const second = await comment(prisma, world, taskId)
    const skipped = await prisma.agentTriggerDelivery.findFirstOrThrow({
      where: { dedupeKey: `ticket:${world.triggerId}:${second}` },
    })
    assert.deepEqual([skipped.status, skipped.errorMessage], ['skipped', 'machine_offline'])
    assert.equal(await prisma.run.count({ where: { threadId: work.threadId } }), runs, 'no model run while it is away')

    // What the project and the owner read meanwhile.
    const chip = await loadTaskTicketWork(prisma, {
      organizationId: world.organizationId, taskId, viewerUserId: world.colleagueId,
    })
    assert.equal(chip.records[0]!.machineOfflineSince, (await prisma.executor.findUniqueOrThrow({
      where: { id: machine },
    })).lastSeenAt!.toISOString())
    const section = await loadTriggerMachineAccess(prisma, {
      organizationId: world.organizationId, triggerId: world.triggerId, viewerUserId: world.authorId,
    })
    assert.ok(section?.tickets[0]?.offlineSince)
    const holder = await loadExecutorHoldingTicket(prisma, {
      executorId: machine, isOrganizationAdmin: false, organizationId: world.organizationId, viewerUserId: world.authorId,
    })
    assert.deepEqual([holder?.policyId, holder?.ticket.status, holder?.ticket.taskId], [world.policyId, 'waiting_machine', taskId])

    // Its next online heartbeat enqueues the sweep, in the heartbeat's own transaction.
    const key = await pairKey(prisma, machine)
    const at = new Date()
    await heartbeat(prisma, { executorId: machine, key, now: at })
    const bucket = Math.floor(at.getTime() / 10_000)
    const enqueued = await prisma.queueJob.findUnique({
      where: { idempotencyKey: `${TICKET_WORK_SWEEP_TOPIC}:machines:${bucket}` },
    })
    // An event's sweep runs the machine steps alone: the minute's tick asks after authors and lost jobs.
    assert.deepEqual(enqueued?.payload, { bucket: String(bucket), machinesOnly: true })
    await runTicketWorkSweep(prisma, LOCAL)
    const back = await recordOf(prisma, work.id)
    assert.deepEqual([back.status, back.stateReason, back.executorId, back.lastWakeReason],
      ['active', null, machine, 'machine_back_online'])
    assert.ok(back.clockStartedAt, 'the hours clock runs again')
    const delivery = await prisma.agentTriggerDelivery.findFirstOrThrow({ where: { source: 'machine', triggerId: world.triggerId } })
    assert.equal(delivery.status, 'delivered')
    const resumed = await prisma.taskEvent.findFirstOrThrow({
      where: { eventType: 'work_resumed', taskId }, orderBy: { createdAt: 'desc' },
    })
    assert.equal((resumed.payload as { previousReason?: string }).previousReason, 'machine_offline')
    const row = await prisma.message.findFirstOrThrow({
      where: { threadId: work.threadId, metadata: { path: ['ticketWorkEvent', 'reason'], equals: 'machine_back_online' } },
    })
    assert.equal(row.content, 'Woken: its machine is back online')

    // A second sweep finds nothing waiting, and wakes nothing twice.
    await finishRuns(prisma, work.threadId)
    await runTicketWorkSweep(prisma, LOCAL)
    assert.equal(await prisma.agentTriggerDelivery.count({ where: { source: 'machine', triggerId: world.triggerId } }), 1)
  })
})

runDatabaseTest('a wake that finds the machine back resumes the work on it at once', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const { machine, taskId, work } = await pausedOffline(prisma, world)
    await prisma.executor.update({ where: { id: machine }, data: { lastSeenAt: new Date(), status: 'online' } })
    await comment(prisma, world, taskId)
    const back = await recordOf(prisma, work.id)
    assert.deepEqual([back.status, back.lastWakeReason], ['active', 'ticket_commented'])
  })
})

runDatabaseTest('past waitingMachineHours the work moves to another machine of the pool, and its old sessions close there', async () => {
  await withMachinesWorld(['Minis', 'Studio'], async (world, prisma) => {
    const { machine, taskId, work } = await pausedOffline(prisma, world)
    const other = world.machines.find((id) => id !== machine)!
    const sessionId = randomUUID()
    await prisma.agentTicketWork.update({ where: { id: work.id }, data: { sessionIds: [sessionId] } })
    const trigger = await prisma.agentTrigger.findUniqueOrThrow({ where: { id: world.triggerId } })
    await prisma.agentTrigger.update({
      where: { id: world.triggerId },
      data: { config: { ...(trigger.config as Record<string, unknown>), waitingMachineHours: 2 } },
    })
    // An hour into its wait: nothing moves.
    await prisma.executor.update({ where: { id: machine }, data: { lastSeenAt: new Date(Date.now() - HOUR) } })
    await prisma.taskEvent.updateMany({
      where: { eventType: 'work_paused', taskId }, data: { createdAt: new Date(Date.now() - HOUR) },
    })
    await runTicketWorkSweep(prisma, LOCAL)
    assert.equal((await recordOf(prisma, work.id)).status, 'waiting_machine')

    // Three hours in: queued again, off the offline machine, and the other machine takes it.
    await prisma.executor.update({ where: { id: machine }, data: { lastSeenAt: new Date(Date.now() - 3 * HOUR) } })
    await prisma.taskEvent.updateMany({
      where: { eventType: 'work_paused', taskId }, data: { createdAt: new Date(Date.now() - 3 * HOUR) },
    })
    await prisma.executor.update({ where: { id: other }, data: { lastSeenAt: new Date(), status: 'online' } })
    await runTicketWorkSweep(prisma, LOCAL)
    const moved = await recordOf(prisma, work.id)
    assert.deepEqual([moved.status, moved.executorId, moved.sessionIds, moved.lastWakeReason],
      ['active', other, [], 'dequeued'])
    const queued = await prisma.taskEvent.findFirstOrThrow({ where: { eventType: 'work_queued', taskId } })
    assert.equal((queued.payload as { previousReason?: string }).previousReason, 'machine_offline')
    const kickoff = await prisma.message.findFirstOrThrow({
      where: { threadId: moved.threadId, metadata: { path: ['ticketWorkKickoff', 'workId'], equals: work.id } },
      orderBy: { createdAt: 'desc' },
    })
    assert.match(kickoff.content,
      /The coding session this ticket had on its last machine was closed when the work moved here/)

    // Its session on the offline machine has a close request, which rides that machine's next heartbeat.
    const close = await prisma.executorCodingSessionCloseRequest.findFirstOrThrow({ where: { sessionId } })
    assert.deepEqual([close.executorId, close.reason, close.resolvedAt], [machine, 'machine_reassigned', null])
    const key = await pairKey(prisma, machine)
    const ownerKey = ticketOwnerKey(world, { executorId: machine, policyId: world.policyId, taskId })
    const answer = await heartbeat(prisma, {
      executorId: machine, key, localMcp: bridgeReport([{ ownerKey, sessionId, status: 'waiting_for_input', turn: 2 }]),
    })
    assert.deepEqual(answer.codingSessionClose, [{ ownerKey, reason: 'machine_reassigned', sessionId }])
    // Back, it holds nothing any more: the work is the other machine's.
    assert.equal(await prisma.agentTicketWork.count({ where: { executorId: machine, status: { in: ['active', 'waiting_machine'] } } }), 0)
  })
})

runDatabaseTest('work handed to a policy whose pool does not name its machine queues for one that does', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const { machine, work } = await pausedOffline(prisma, world)
    const sessionId = randomUUID()
    await prisma.agentTicketWork.update({ where: { id: work.id }, data: { sessionIds: [sessionId] } })
    // As a confirmation that replaced the policy with one on other machines leaves it.
    await prisma.executorStandingPolicyExecutor.deleteMany({ where: { executorId: machine, policyId: world.policyId } })
    await prisma.executor.update({ where: { id: machine }, data: { lastSeenAt: new Date(), status: 'online' } })
    await runTicketWorkSweep(prisma, LOCAL)
    const moved = await recordOf(prisma, work.id)
    assert.deepEqual([moved.status, moved.executorId, moved.sessionIds], ['queued', null, []])
    const close = await prisma.executorCodingSessionCloseRequest.findFirstOrThrow({ where: { sessionId } })
    assert.deepEqual([close.executorId, close.reason], [machine, 'machine_reassigned'])
    assert.equal(await prisma.agentTriggerDelivery.count({ where: { source: 'machine', triggerId: world.triggerId } }), 0,
      'no machine_back_online wake for a machine the work is not bound to')
  })
})
