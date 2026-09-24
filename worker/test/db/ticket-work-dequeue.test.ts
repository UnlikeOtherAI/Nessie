import assert from 'node:assert/strict'

import type { PrismaClient } from '@prisma/client'
import { createAgentTrigger, updateProjectTask } from '@nessie/team-admin'

import { INSTRUCTIONS } from '../../../packages/team-admin/test/standing-policy-fixture.js'
import { dequeueTicketWork } from '../../src/control/ticket-work-dequeue.js'
import { runTicketWorkSweep } from '../../src/control/ticket-work-sweep.js'
import {
  LOCAL,
  MINUTE,
  SESSION,
  drainDispatch,
  finishRuns,
  moveTo,
  pickUp,
  withMachinesWorld,
  type MachinesWorld,
} from './ticket-work-machines-fixture.js'
import { runDatabaseTest } from './support.js'

/**
 * The dequeue against Postgres (T5; docs/standards/ticket-work-machine-access.md
 * → "The dequeue"): a free machine takes the queued record first in line
 * across every policy that shares it — priority, then age; a priority change
 * re-sorts a queue and wakes nothing; the record's ticket and its mover are
 * checked again and a record that no longer stands is cancelled with its
 * reason; a policy whose digests moved is suspended, never placed under; a
 * record waits for the machine it last worked on while that machine stands;
 * and nothing ever puts two records on one machine.
 */

/** A second ticket trigger of the same agent, starting work from its own column, with its own policy on these machines. */
const secondTrigger = async (prisma: PrismaClient, world: MachinesWorld) => {
  const ready = await prisma.boardColumn.create({
    data: { boardId: world.board, category: 'in_progress', name: 'Ready', organizationId: world.organizationId, position: 5 },
  })
  const trigger = await createAgentTrigger(prisma, world.agentId, {
    config: { instructions: INSTRUCTIONS, pickup: { columns: [{ id: ready.id }] } },
    name: 'Pick up ready tickets',
    targetChannelId: world.engId,
    type: 'ticket_changed',
  }, { authorUserId: world.authorId })
  assert.ok(trigger)
  const prepared = await world.prepare({ executorIds: world.machines, triggerId: trigger.id })
  await world.confirm(prepared)
  return { columnId: ready.id, policyId: prepared.policyId, triggerId: trigger.id }
}

const recordOf = (prisma: PrismaClient, id: string) => prisma.agentTicketWork.findUniqueOrThrow({ where: { id } })

const sweep = async (prisma: PrismaClient) => runTicketWorkSweep(prisma, LOCAL)

const age = (prisma: PrismaClient, id: string, minutes: number) =>
  prisma.agentTicketWork.update({ where: { id }, data: { enqueuedAt: new Date(Date.now() - minutes * MINUTE) } })

runDatabaseTest('a free machine takes the highest priority, then the oldest, queued ticket across both policies', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const seen = new Set<string>()
    const second = await secondTrigger(prisma, world)
    const a = await pickUp(prisma, world, 'Holds the machine', seen)
    assert.equal(a.work.status, 'active')
    const b = await pickUp(prisma, world, 'Medium, second oldest', seen)
    const c = await pickUp(prisma, world, 'High, newest', seen, {
      columnId: second.columnId, priority: 'high', triggerId: second.triggerId,
    })
    const d = await pickUp(prisma, world, 'Medium, oldest', seen, { columnId: second.columnId, triggerId: second.triggerId })
    await age(prisma, b.work.id, 5)
    await age(prisma, c.work.id, 1)
    await age(prisma, d.work.id, 10)
    for (const queued of [b, c, d]) assert.equal((await recordOf(prisma, queued.work.id)).status, 'queued')
    assert.deepEqual([(await recordOf(prisma, c.work.id)).policyId, (await recordOf(prisma, b.work.id)).policyId],
      [second.policyId, world.policyId])

    const order: string[] = []
    let holder = a
    for (let round = 0; round < 3; round += 1) {
      await moveTo(prisma, world, holder.taskId, world.columns.done)
      await sweep(prisma)
      const active = await prisma.agentTicketWork.findFirstOrThrow({
        where: { executorId: world.machines[0], status: 'active' },
      })
      order.push(active.id)
      assert.equal(active.lastWakeReason, 'dequeued')
      holder = [b, c, d].find((ticket) => ticket.work.id === active.id)!
      await finishRuns(prisma, active.threadId)
      // Everyone still waiting was told their place again.
      const waiting = await prisma.agentTicketWork.findMany({
        where: { id: { in: [b.work.id, c.work.id, d.work.id] }, status: 'queued' }, select: { queuePosition: true },
      })
      for (const record of waiting) assert.equal(record.queuePosition, 1, 'one left in each policy\'s queue at most')
    }
    assert.deepEqual(order, [c.work.id, d.work.id, b.work.id], 'high first, then medium by age, whichever policy')
    assert.equal(await prisma.agentTriggerDelivery.count({
      where: { source: 'dequeue', triggerId: { in: [world.triggerId, second.triggerId] } },
    }), 3)
  })
})

runDatabaseTest('a queued ticket\'s new priority re-sorts its queue and wakes nothing', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const seen = new Set<string>()
    await pickUp(prisma, world, 'Holds the machine', seen)
    const older = await pickUp(prisma, world, 'Queued first', seen)
    const newer = await pickUp(prisma, world, 'Queued second', seen)
    await age(prisma, older.work.id, 5)
    await updateProjectTask(prisma, {
      actorId: world.colleagueId, fields: { priority: 'low' }, organizationId: world.organizationId, origin: SESSION,
      taskId: older.taskId,
    })
    assert.deepEqual([(await recordOf(prisma, newer.work.id)).queuePosition, (await recordOf(prisma, older.work.id)).queuePosition],
      [1, 2])
    const before = await recordOf(prisma, newer.work.id)
    await updateProjectTask(prisma, {
      actorId: world.colleagueId, fields: { priority: 'urgent' }, organizationId: world.organizationId, origin: SESSION,
      taskId: older.taskId,
    })
    await drainDispatch(prisma, world, seen)
    const [first, second] = [await recordOf(prisma, older.work.id), await recordOf(prisma, newer.work.id)]
    assert.deepEqual([first.queuePosition, second.queuePosition], [1, 2], 'the urgent ticket goes first')
    assert.deepEqual([first.wakeCount, second.wakeCount], [older.work.wakeCount, before.wakeCount], 'and nobody woke')
  })
})

runDatabaseTest('the dequeue cancels a ticket that left its start-work column, or whose mover can no longer edit the board', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const seen = new Set<string>()
    const blocked = await prisma.boardColumn.create({
      data: { boardId: world.board, category: 'in_progress', name: 'Blocked', organizationId: world.organizationId, position: 6 },
    })
    const a = await pickUp(prisma, world, 'Holds the machine', seen)
    const left = await pickUp(prisma, world, 'Moved aside while queued', seen)
    const next = await pickUp(prisma, world, 'Still waiting', seen)
    await age(prisma, left.work.id, 5)
    // A column that neither starts, parks nor ends work: the record stays queued, out of place.
    await moveTo(prisma, world, left.taskId, blocked.id)
    assert.equal((await recordOf(prisma, left.work.id)).status, 'queued')

    await moveTo(prisma, world, a.taskId, world.columns.done)
    await sweep(prisma)
    const cancelled = await recordOf(prisma, left.work.id)
    assert.deepEqual([cancelled.status, cancelled.stateReason], ['cancelled', 'left_flow'])
    const ended = await prisma.taskEvent.findFirstOrThrow({ where: { eventType: 'work_ended', taskId: left.taskId } })
    assert.equal((ended.payload as { reason: string }).reason, 'left_flow')
    const stopped = await prisma.message.findFirstOrThrow({
      where: { threadId: cancelled.threadId, metadata: { path: ['ticketWorkEvent', 'kind'], equals: 'stopped' } },
    })
    assert.match(stopped.content, /left its start-work column while it waited for a machine/)
    const placed = await recordOf(prisma, next.work.id)
    assert.deepEqual([placed.status, placed.executorId], ['active', world.machines[0]], 'the next in line took the machine')

    // The person whose move started the next queued ticket loses the board.
    await finishRuns(prisma, placed.threadId)
    const orphan = await pickUp(prisma, world, 'Its mover leaves', seen)
    await prisma.projectMember.deleteMany({ where: { projectId: world.projectId, userId: world.colleagueId } })
    await moveTo(prisma, world, next.taskId, world.columns.done)
    await sweep(prisma)
    const lost = await recordOf(prisma, orphan.work.id)
    assert.deepEqual([lost.status, lost.stateReason], ['cancelled', 'mover_lost_access'])
  })
})

runDatabaseTest('a policy whose trigger moved under it is suspended at dequeue, and its queue waits', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const seen = new Set<string>()
    const a = await pickUp(prisma, world, 'Holds the machine', seen)
    const queued = await pickUp(prisma, world, 'Waits', seen)
    // A pinned field changed without the door that suspends: the dequeue finds it.
    const trigger = await prisma.agentTrigger.findUniqueOrThrow({ where: { id: world.triggerId } })
    const config = trigger.config as { instructions: Record<string, string> }
    await prisma.agentTrigger.update({
      where: { id: world.triggerId },
      data: { config: { ...config, instructions: { ...config.instructions, general: 'Something else entirely.' } } },
    })
    await moveTo(prisma, world, a.taskId, world.columns.done)
    await sweep(prisma)
    const policy = await prisma.executorStandingPolicy.findUniqueOrThrow({ where: { id: world.policyId } })
    assert.deepEqual([policy.status, policy.suspendedReason], ['suspended', 'trigger_changed'])
    const waiting = await recordOf(prisma, queued.work.id)
    assert.deepEqual([waiting.status, waiting.executorId], ['queued', null], 'placed under nothing, cancelled by nothing')
  })
})

runDatabaseTest('queued work waits for the machine it last worked on while that machine stands', async () => {
  await withMachinesWorld(['Minis', 'Studio'], async (world, prisma) => {
    const seen = new Set<string>()
    const first = await pickUp(prisma, world, 'Works on one', seen)
    const second = await pickUp(prisma, world, 'Works on the other', seen)
    const own = first.work.executorId!
    const other = second.work.executorId!
    assert.notEqual(own, other)
    const fresh = await pickUp(prisma, world, 'New ticket', seen)
    await age(prisma, fresh.work.id, 60)
    // The first ticket's work waits for its own machine again — its sessions are there — as a
    // parked record sent back to a busy machine does, while other work holds that machine.
    await prisma.agentTicketWork.update({
      where: { id: first.work.id }, data: { enqueuedAt: new Date(Date.now() - 30 * MINUTE), status: 'queued' },
    })
    const blocker = await world.work({
      executorId: own, policyId: world.policyId, status: 'active', taskId: await world.task('Holds its machine'),
    })

    // The other machine frees: the new ticket takes it, older or not, and the first keeps waiting for its own.
    await moveTo(prisma, world, second.taskId, world.columns.done)
    await sweep(prisma)
    assert.deepEqual([(await recordOf(prisma, fresh.work.id)).executorId, (await recordOf(prisma, first.work.id)).status],
      [other, 'queued'])
    // Its own machine frees: it goes back to it.
    await prisma.agentTicketWork.update({
      where: { id: blocker.id },
      data: { endedAt: new Date(), endedReason: 'left_flow', stateReason: 'left_flow', status: 'done' },
    })
    await sweep(prisma)
    const back = await recordOf(prisma, first.work.id)
    assert.deepEqual([back.status, back.executorId], ['active', own])
  })
})

runDatabaseTest('a new pickup does not take a free machine ahead of the work queued for it', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const seen = new Set<string>()
    const a = await pickUp(prisma, world, 'Holds the machine', seen)
    const waiting = await pickUp(prisma, world, 'Queued first', seen)
    // The machine frees; before the dispatcher runs, another person's pickup arrives.
    await moveTo(prisma, world, a.taskId, world.columns.done)
    const late = await pickUp(prisma, world, 'Picked up after', seen)
    assert.deepEqual([(await recordOf(prisma, late.work.id)).status, (await recordOf(prisma, late.work.id)).queuePosition],
      ['queued', 2], 'it joins the line behind the ticket already in it')
    await sweep(prisma)
    assert.deepEqual([(await recordOf(prisma, waiting.work.id)).status, (await recordOf(prisma, late.work.id)).status],
      ['active', 'queued'])
    // An urgent ticket outranks the line, and takes a free machine at once.
    await moveTo(prisma, world, waiting.taskId, world.columns.done)
    const urgent = await pickUp(prisma, world, 'Urgent', seen, { priority: 'urgent' })
    assert.equal((await recordOf(prisma, urgent.work.id)).status, 'active')
  })
})

runDatabaseTest('two dequeues racing for one free machine put one record on it', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const seen = new Set<string>()
    const [minis] = world.machines as [string]
    // The machine offline at pickup: both tickets queue, and it is free when it comes back.
    await prisma.executor.update({ where: { id: minis }, data: { status: 'offline' } })
    const one = await pickUp(prisma, world, 'One', seen)
    const two = await pickUp(prisma, world, 'Two', seen)
    assert.deepEqual([(await recordOf(prisma, one.work.id)).stateReason, (await recordOf(prisma, two.work.id)).stateReason],
      ['queued_machines_offline', 'queued_machines_offline'])
    await prisma.executor.update({ where: { id: minis }, data: { lastSeenAt: new Date(), status: 'online' } })
    const now = new Date()
    const started = await Promise.all([dequeueTicketWork(prisma, { now }), dequeueTicketWork(prisma, { now })])
    assert.equal(started[0] + started[1], 1)
    const active = await prisma.agentTicketWork.findMany({ where: { executorId: minis, status: { in: ['active', 'waiting_machine'] } } })
    assert.equal(active.length, 1)
    // And the index refuses a second holder whatever writes it.
    const loser = active[0]!.id === one.work.id ? two.work.id : one.work.id
    await assert.rejects(
      prisma.agentTicketWork.update({ where: { id: loser }, data: { executorId: minis, status: 'active' } }),
      /Unique constraint/,
    )
    assert.equal((await recordOf(prisma, loser)).queuePosition, 1)
  })
})
