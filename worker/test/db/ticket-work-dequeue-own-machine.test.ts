import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { Prisma, type PrismaClient } from '@prisma/client'

import { bridgeReport } from '../../../packages/team-admin/test/standing-policy-binding-fixture.js'
import { runTicketWorkSweep } from '../../src/control/ticket-work-sweep.js'
import {
  LOCAL,
  MINUTE,
  finishRuns,
  moveTo,
  pickUp,
  ticketOwnerKey,
  withMachinesWorld,
  type MachinesWorld,
} from './ticket-work-machines-fixture.js'
import { runDatabaseTest } from './support.js'

/**
 * The machine a queued record last worked on, against Postgres (T5;
 * docs/standards/ticket-work-machine-access.md → "The dequeue"): the record
 * goes back to it first — its own sessions there never count against it — but
 * never starves for it. Its machine offline or held by other work, it takes
 * another free machine of its pool, and the sessions it leaves behind are
 * closed there (`machine_reassigned`) and forgotten. A session quota counts the
 * sessions the bridge counts: a failed or closed one is not live.
 */

const recordOf = (prisma: PrismaClient, id: string) => prisma.agentTicketWork.findUniqueOrThrow({ where: { id } })

/** Work that last ran on this machine, back in the queue — as a parked record sent back while it was busy. */
const requeued = (prisma: PrismaClient, id: string, sessionIds: string[]) => prisma.agentTicketWork.update({
  where: { id },
  data: { enqueuedAt: new Date(Date.now() - 30 * MINUTE), sessionIds, stateReason: 'queued_no_free_machine', status: 'queued' },
})

const closesOn = (prisma: PrismaClient, executorId: string) => prisma.executorCodingSessionCloseRequest.findMany({
  where: { executorId }, select: { reason: true, sessionId: true },
})

/** The machine's last report, with these sessions of one ticket on it. */
const reportOn = (prisma: PrismaClient, executorId: string, sessions: Array<{ ownerKey: string; status: string }>) =>
  prisma.executor.update({
    where: { id: executorId },
    data: {
      lastSeenAt: new Date(),
      localMcp: bridgeReport(sessions.map((session) => ({ ...session, sessionId: randomUUID(), turn: 1 }))) as
        unknown as Prisma.InputJsonValue,
      status: 'online',
    },
  })

const machinesOf = (world: MachinesWorld) => world.machines as [string, string]

runDatabaseTest('queued work whose machine went offline takes another free machine, and its sessions there close', async () => {
  await withMachinesWorld(['Minis', 'Studio'], async (world, prisma) => {
    const ticket = await pickUp(prisma, world, 'Worked on one machine', new Set())
    const own = ticket.work.executorId!
    const other = machinesOf(world).find((machine) => machine !== own)!
    const sessionId = randomUUID()
    await requeued(prisma, ticket.work.id, [sessionId])
    // Its machine goes away minutes ago — well inside the trigger's hours to wait for it.
    await prisma.executor.update({ where: { id: own }, data: { lastSeenAt: new Date(Date.now() - 5 * MINUTE), status: 'offline' } })
    await runTicketWorkSweep(prisma, LOCAL)
    const moved = await recordOf(prisma, ticket.work.id)
    assert.deepEqual([moved.status, moved.executorId, moved.lastWakeReason], ['active', other, 'dequeued'])
    assert.deepEqual(moved.sessionIds, [], 'the sessions it left behind are not the ticket\'s any more')
    assert.deepEqual(await closesOn(prisma, own), [{ reason: 'machine_reassigned', sessionId }])
    const kickoff = await prisma.message.findFirstOrThrow({
      where: { threadId: moved.threadId, metadata: { path: ['ticketWorkKickoff', 'workId'], equals: moved.id } },
      orderBy: { createdAt: 'desc' },
    })
    assert.match(kickoff.content,
      /The coding session this ticket had on its last machine was closed when the work moved here: start a new one/)
  })
})

runDatabaseTest('queued work whose machine other work holds takes another free machine rather than wait', async () => {
  await withMachinesWorld(['Minis', 'Studio'], async (world, prisma) => {
    const seen = new Set<string>()
    const ticket = await pickUp(prisma, world, 'Worked on one machine', seen)
    const own = ticket.work.executorId!
    const busy = await pickUp(prisma, world, 'Holds the other', seen)
    await requeued(prisma, ticket.work.id, [])
    const blocker = await world.work({
      executorId: own, policyId: world.policyId, status: 'active', taskId: await world.task('Holds its machine'),
    })
    // The other machine frees while its own stays held.
    await moveTo(prisma, world, busy.taskId, world.columns.done)
    await runTicketWorkSweep(prisma, LOCAL)
    const placed = await recordOf(prisma, ticket.work.id)
    assert.deepEqual([placed.status, placed.executorId], ['active', busy.work.executorId])
    assert.equal((await recordOf(prisma, blocker.id)).executorId, own)
  })
})

runDatabaseTest('queued work goes back to its own machine at its own session quota, and a quota counts live sessions', async () => {
  await withMachinesWorld(['Minis', 'Studio'], async (world, prisma) => {
    const seen = new Set<string>()
    const ticket = await pickUp(prisma, world, 'Its sessions are there', seen)
    const own = ticket.work.executorId!
    const ownerKey = ticketOwnerKey(world, { executorId: own, policyId: world.policyId, taskId: ticket.taskId })
    await requeued(prisma, ticket.work.id, [])
    // Three of its own sessions live there: the machine's quota for this ticket, and its own.
    await reportOn(prisma, own, Array.from({ length: 3 }, () => ({ ownerKey, status: 'waiting_for_input' })))
    await runTicketWorkSweep(prisma, LOCAL)
    const back = await recordOf(prisma, ticket.work.id)
    assert.deepEqual([back.status, back.executorId], ['active', own])
    assert.deepEqual(await closesOn(prisma, own), [], 'back on its own machine, nothing of it closes')

    // A ticket new to the other machine, whose sessions there all failed: none of them is live.
    await finishRuns(prisma, back.threadId)
    const other = machinesOf(world).find((machine) => machine !== own)!
    await prisma.executor.update({ where: { id: other }, data: { status: 'offline' } })
    const fresh = await pickUp(prisma, world, 'Tried there before', seen)
    assert.equal((await recordOf(prisma, fresh.work.id)).status, 'queued')
    const freshKey = ticketOwnerKey(world, { executorId: other, policyId: world.policyId, taskId: fresh.taskId })
    await reportOn(prisma, other, Array.from({ length: 3 }, () => ({ ownerKey: freshKey, status: 'failed' })))
    await runTicketWorkSweep(prisma, LOCAL)
    const placed = await recordOf(prisma, fresh.work.id)
    assert.deepEqual([placed.status, placed.executorId], ['active', other])
  })
})
