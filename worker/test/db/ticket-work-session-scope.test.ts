import assert from 'node:assert/strict'

import type { PrismaClient } from '@prisma/client'
import type { ExecutorLocalMcpReport } from '@nessie/schemas'

import { bridgeReport } from '../../../packages/team-admin/test/standing-policy-binding-fixture.js'
import { reportFrom, sessionJobs, ticketOwnerKey, withMachinesWorld, workingTicket } from './ticket-work-machines-fixture.js'
import { runDatabaseTest } from './support.js'

/**
 * Whose report a session wake may come from, against Postgres (T5;
 * docs/standards/ticket-work-machine-access.md → "A ticket's coding session
 * wakes its work"): only the machine the record is pinned to, and only for the
 * sessions it lists under the ticket's own owner key — another machine, or
 * another owner, wakes and closes nothing. And a report that did not carry the
 * sessions between two that did never hides a close.
 */

const keysOf = async (prisma: PrismaClient, workId: string) =>
  (await sessionJobs(prisma, workId)).map((job) => job.idempotencyKey)

const recordOf = (prisma: PrismaClient, id: string) => prisma.agentTicketWork.findUniqueOrThrow({ where: { id } })

runDatabaseTest('a report from a machine the work is not pinned to, or a session under another owner, wakes nothing', async () => {
  await withMachinesWorld(['Minis', 'Studio'], async (world, prisma) => {
    const ticket = await workingTicket(prisma, world)
    const other = world.machines.find((machine) => machine !== ticket.machine)!
    const session = (ownerKey: string, status: string, turn = 3) =>
      bridgeReport([{ ownerKey, sessionId: ticket.sessionId, status, turn }])
    // The author's other machine names the ticket's session, under either machine's key for it.
    const otherKey = ticketOwnerKey(world, { executorId: other, policyId: world.policyId, taskId: ticket.taskId })
    for (const ownerKey of [ticket.ownerKey, otherKey]) {
      await reportFrom(prisma, other, session(ownerKey, 'working', 2))
      await reportFrom(prisma, other, session(ownerKey, 'waiting_for_input'))
      await reportFrom(prisma, other, bridgeReport([]))
    }
    // Its own machine lists it under an owner that is not the ticket's.
    const foreign = `sha256:${'d'.repeat(64)}`
    await reportFrom(prisma, ticket.machine, session(foreign, 'working', 2))
    await reportFrom(prisma, ticket.machine, session(foreign, 'interrupted'))
    await reportFrom(prisma, ticket.machine, bridgeReport([]))
    assert.deepEqual(await keysOf(prisma, ticket.workId), [], 'no wake, and no close, from any of them')
    assert.deepEqual((await recordOf(prisma, ticket.workId)).sessionIds, [ticket.sessionId])

    // The machine it is pinned to, under the ticket's own key: that one wakes it.
    await reportFrom(prisma, ticket.machine, session(ticket.ownerKey, 'working', 2))
    await reportFrom(prisma, ticket.machine, session(ticket.ownerKey, 'waiting_for_input'))
    assert.deepEqual(await keysOf(prisma, ticket.workId), [`session:${ticket.sessionId}:3:waiting_for_input`])
  })
})

runDatabaseTest('a report without its sessions between two that have them never hides a close', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const ticket = await workingTicket(prisma, world)
    await reportFrom(prisma, ticket.machine, bridgeReport([
      { ownerKey: ticket.ownerKey, sessionId: ticket.sessionId, status: 'working', turn: 2 },
    ]))
    // The bridge was not asked this once; the stored report keeps what the last one said.
    await reportFrom(prisma, ticket.machine, [{
      available: true, observedAt: new Date().toISOString(), server: 'coding-sessions',
    }] as ExecutorLocalMcpReport)
    const stored = await prisma.executor.findUniqueOrThrow({ where: { id: ticket.machine }, select: { localMcp: true } })
    assert.equal((stored.localMcp as Array<{ codingSessions?: unknown[] }>)[0]?.codingSessions?.length, 1)
    // Then a list that could hold it, without it: it closed while the bridge went unasked.
    await reportFrom(prisma, ticket.machine, bridgeReport([]))
    assert.deepEqual(await keysOf(prisma, ticket.workId), [`session:${ticket.sessionId}:2:closed`])
    assert.deepEqual((await recordOf(prisma, ticket.workId)).sessionIds, [])
  })
})

runDatabaseTest('a session recorded as started on another machine is not this machine\'s report to speak for', async () => {
  await withMachinesWorld(['Minis', 'Studio'], async (world, prisma) => {
    const ticket = await workingTicket(prisma, world)
    const other = world.machines.find((machine) => machine !== ticket.machine)!
    // Its origin says the other machine started it, whatever machine the record holds now.
    await prisma.agentTicketWork.update({
      where: { id: ticket.workId },
      data: {
        sessionOrigins: {
          [ticket.sessionId]: { executorId: other, policyId: world.policyId, startedAt: new Date().toISOString() },
        },
      },
    })
    const session = (status: string) =>
      bridgeReport([{ ownerKey: ticket.ownerKey, sessionId: ticket.sessionId, status, turn: 3 }])
    await reportFrom(prisma, ticket.machine, session('working'))
    await reportFrom(prisma, ticket.machine, session('waiting_for_input'))
    await reportFrom(prisma, ticket.machine, bridgeReport([]))
    assert.deepEqual(await keysOf(prisma, ticket.workId), [])
    assert.deepEqual((await recordOf(prisma, ticket.workId)).sessionIds, [ticket.sessionId])
  })
})

runDatabaseTest('a session the work let go of is charged until its machine stops reporting it', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const ticket = await workingTicket(prisma, world)
    await prisma.agentTicketWork.update({
      where: { id: ticket.workId },
      data: {
        sessionOrigins: {
          [ticket.sessionId]: { executorId: ticket.machine, policyId: world.policyId, startedAt: new Date().toISOString() },
        },
      },
    })
    const costing = (totalCostUsd: number, status = 'working') => bridgeReport([
      { ownerKey: ticket.ownerKey, sessionId: ticket.sessionId, status, totalCostUsd, turn: 1 },
    ])
    await reportFrom(prisma, ticket.machine, costing(1))
    assert.equal(Number((await recordOf(prisma, ticket.workId)).costUsd), 1)
    // The work lets the session go (its agent closed it, or it left the machine): it leaves the live set.
    await prisma.agentTicketWork.update({ where: { id: ticket.workId }, data: { sessionIds: [] } })
    await reportFrom(prisma, ticket.machine, costing(2.5))
    await reportFrom(prisma, ticket.machine, costing(3, 'closed'))
    assert.equal(Number((await recordOf(prisma, ticket.workId)).costUsd), 3, 'what it cost up to its close is the ticket\'s')
    await reportFrom(prisma, ticket.machine, bridgeReport([]))
    assert.equal(Number((await recordOf(prisma, ticket.workId)).costUsd), 3)
  })
})
