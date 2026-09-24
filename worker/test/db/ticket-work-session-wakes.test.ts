import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import { TICKET_WORK_SWEEP_TOPIC, type ExecutorLocalMcpReport } from '@nessie/schemas'

import { bridgeReport, heartbeat, pairKey } from '../../../packages/team-admin/test/standing-policy-binding-fixture.js'
import {
  drainSessionJobs,
  finishRuns,
  moveTo,
  pickUp,
  sessionJobs,
  ticketOwnerKey,
  withMachinesWorld,
  type MachinesWorld,
} from './ticket-work-machines-fixture.js'
import { runDatabaseTest } from './support.js'

/**
 * Session wakes against Postgres (T5; docs/standards/ticket-work-machine-access.md
 * → "A ticket's coding session wakes its work"): the heartbeat intake over two
 * reports enqueues `ticket-work.session` in the heartbeat's own transaction,
 * and the subscriber wakes the record through the ticket-work seam — a fast
 * turn inside one report exactly once, an interruption and a failure, a
 * session missing from the report as closed except at the row cap, nothing
 * from a report without the field, and nothing the agent's own read already
 * saw or that finds the work no longer active.
 */

type Ticket = { key: Awaited<ReturnType<typeof pairKey>>; ownerKey: string; sessionId: string; taskId: string; workId: string }

/** One picked-up ticket working on the world's machine, with one session on record. */
const working = async (prisma: PrismaClient, world: MachinesWorld): Promise<Ticket> => {
  const [machine] = world.machines as [string]
  const { taskId, work } = await pickUp(prisma, world, 'Fix login redirect', new Set())
  assert.equal(work.status, 'active')
  const sessionId = randomUUID()
  await prisma.agentTicketWork.update({ where: { id: work.id }, data: { sessionIds: [sessionId] } })
  return {
    key: await pairKey(prisma, machine),
    ownerKey: ticketOwnerKey(world, { executorId: machine, policyId: world.policyId, taskId }),
    sessionId,
    taskId,
    workId: work.id,
  }
}

/** One signed heartbeat from the world's machine, carrying this report (or none). */
const report = (
  client: PrismaClient,
  world: MachinesWorld,
  ticket: Ticket,
  localMcp: ExecutorLocalMcpReport | undefined,
  now = new Date(),
) => heartbeat(client, { executorId: world.machines[0]!, key: ticket.key, now, ...(localMcp ? { localMcp } : {}) })

const withTicket = (run: (world: MachinesWorld, client: PrismaClient, ticket: Ticket) => Promise<void>) =>
  withMachinesWorld(['Minis'], async (world, client) => {
    await run(world, client, await working(client, world))
  })

const keysOf = async (client: PrismaClient, workId: string) =>
  (await sessionJobs(client, workId)).map((job) => job.idempotencyKey)

runDatabaseTest('a fast turn inside one report wakes the ticket exactly once', async () => {
  await withTicket(async (world, client, ticket) => {
    const session = (turn: number, status = 'waiting_for_input') =>
      bridgeReport([{ ownerKey: ticket.ownerKey, sessionId: ticket.sessionId, status, turn }])
    await report(client, world, ticket, session(3))
    // Its first report already showed turn 3 ended; the agent saw it through its own wait.
    await client.agentTicketWork.update({ where: { id: ticket.workId }, data: { lastObservedTurn: { [ticket.sessionId]: 3 } } })
    // Turn 4 began and ended between two heartbeats: the status reads the same, the turn moved.
    await report(client, world, ticket, session(4))
    await report(client, world, ticket, session(4))
    assert.deepEqual(await keysOf(client, ticket.workId), [
      `session:${ticket.sessionId}:3:waiting_for_input`,
      `session:${ticket.sessionId}:4:waiting_for_input`,
    ], 'one job per turn, however often the report repeats')

    const before = await client.agentTicketWork.findUniqueOrThrow({ where: { id: ticket.workId } })
    const seen = new Set<string>()
    await drainSessionJobs(client, ticket.workId, seen)
    const deliveries = await client.agentTriggerDelivery.findMany({
      where: { source: 'session', triggerId: world.triggerId }, orderBy: { createdAt: 'asc' },
    })
    assert.deepEqual(deliveries.map((row) => [row.dedupeKey, row.status, row.errorMessage]), [
      [`session:${ticket.sessionId}:3:waiting_for_input`, 'skipped', 'no_longer_applies'],
      [`session:${ticket.sessionId}:4:waiting_for_input`, 'delivered', null],
    ], 'the turn the agent already saw is skipped, and said so')
    const woken = await client.agentTicketWork.findUniqueOrThrow({ where: { id: ticket.workId } })
    assert.deepEqual([woken.lastWakeReason, woken.wakeCount], ['session_turn_ended', before.wakeCount + 1])
    const row = await client.message.findFirstOrThrow({
      where: { threadId: woken.threadId, metadata: { path: ['ticketWorkEvent', 'reason'], equals: 'session_turn_ended' } },
    })
    assert.equal(row.content, 'Woken: the coding session\'s turn 4 ended')
    const kickoff = await client.message.findFirstOrThrow({
      where: { threadId: woken.threadId, metadata: { path: ['ticketWorkKickoff', 'workId'], equals: ticket.workId } },
      orderBy: { createdAt: 'desc' },
    })
    assert.match(kickoff.content, /session_turn_ended: This ticket's coding session ended turn 4/)
    assert.match(kickoff.content, /when this ticket's coding session ends a turn, is interrupted, fails or closes/)

    // The job delivered twice — the queue is at least once — wakes nothing twice.
    await drainSessionJobs(client, ticket.workId, new Set())
    assert.equal(await client.agentTriggerDelivery.count({ where: { source: 'session', triggerId: world.triggerId } }), 2)
    assert.equal((await client.agentTicketWork.findUniqueOrThrow({ where: { id: ticket.workId } })).wakeCount,
      before.wakeCount + 1)
  })
})

runDatabaseTest('an interruption and a failure each wake, with what to do next', async () => {
  await withTicket(async (world, client, ticket) => {
    const session = (status: string, reason?: string) => bridgeReport([{
      ownerKey: ticket.ownerKey, sessionId: ticket.sessionId, status, turn: 5, ...(reason ? { reason } : {}),
    }])
    const seen = new Set<string>()
    await report(client, world, ticket, session('working'))
    await report(client, world, ticket, session('interrupted', 'max_turn_minutes'))
    await drainSessionJobs(client, ticket.workId, seen)
    const interrupted = await client.agentTicketWork.findUniqueOrThrow({ where: { id: ticket.workId } })
    assert.equal(interrupted.lastWakeReason, 'session_interrupted')
    const kickoff = await client.message.findFirstOrThrow({
      where: { threadId: interrupted.threadId, metadata: { path: ['ticketWorkKickoff', 'workId'], equals: ticket.workId } },
      orderBy: { createdAt: 'desc' },
    })
    assert.match(kickoff.content, /interrupted in turn 5 \(max_turn_minutes\)\. It hit its per-turn time limit and can resume: send it "continue"/)

    await finishRuns(client, interrupted.threadId)
    await report(client, world, ticket, session('failed', 'agent_missing'))
    await drainSessionJobs(client, ticket.workId, seen)
    const failed = await client.agentTicketWork.findUniqueOrThrow({ where: { id: ticket.workId } })
    assert.equal(failed.lastWakeReason, 'session_failed')
    assert.equal(failed.wakeCount, interrupted.wakeCount + 1)
    const delivery = await client.agentTriggerDelivery.findFirstOrThrow({
      where: { dedupeKey: `session:${ticket.sessionId}:5:failed`, triggerId: world.triggerId },
    })
    assert.deepEqual((delivery.payload as { session: unknown }).session,
      { reason: 'agent_missing', sessionId: ticket.sessionId, status: 'failed', turn: 5 })
  })
})

runDatabaseTest('a session missing from the report counts closed, but not from a report at its row cap', async () => {
  await withTicket(async (world, client, ticket) => {
    const others = (count: number) => Array.from({ length: count }, () => ({
      ownerKey: `sha256:${'c'.repeat(64)}`, sessionId: randomUUID(), status: 'waiting_for_input', turn: 1,
    }))
    const ours = { ownerKey: ticket.ownerKey, sessionId: ticket.sessionId, status: 'waiting_for_input', turn: 2 }
    const crowd = others(31)
    await report(client, world, ticket, bridgeReport([ours, ...crowd]))
    // Thirty-two other sessions and not ours: the list is full, so it proves nothing.
    await report(client, world, ticket, bridgeReport([...crowd, ...others(1)]))
    assert.ok(!(await keysOf(client, ticket.workId)).includes(`session:${ticket.sessionId}:2:closed`))
    assert.deepEqual((await client.agentTicketWork.findUniqueOrThrow({ where: { id: ticket.workId } })).sessionIds,
      [ticket.sessionId])

    // Back in a list that could hold it, then gone from one: closed.
    await report(client, world, ticket, bridgeReport([ours]))
    const at = new Date()
    await report(client, world, ticket, bridgeReport(others(2)), at)
    assert.ok((await keysOf(client, ticket.workId)).includes(`session:${ticket.sessionId}:2:closed`))
    const record = await client.agentTicketWork.findUniqueOrThrow({ where: { id: ticket.workId } })
    assert.deepEqual(record.sessionIds, [], 'a closed session leaves the record\'s live set at once')
    const bucket = Math.floor(at.getTime() / 10_000)
    assert.ok(await client.queueJob.findUnique({ where: { idempotencyKey: `${TICKET_WORK_SWEEP_TOPIC}:${bucket}` } }),
      'the dispatcher is told: the ticket\'s session quota has room again')

    await drainSessionJobs(client, ticket.workId, new Set())
    const closed = await client.agentTicketWork.findUniqueOrThrow({ where: { id: ticket.workId } })
    assert.equal(closed.lastWakeReason, 'session_closed')
  })
})

runDatabaseTest('a report without the field, or no report at all, infers nothing', async () => {
  await withTicket(async (world, client, ticket) => {
    await report(client, world, ticket, bridgeReport([
      { ownerKey: ticket.ownerKey, sessionId: ticket.sessionId, status: 'working', turn: 1 },
    ]))
    // The bridge was not asked this time: absent means not asked, never none.
    const unasked = [{
      available: true, observedAt: new Date().toISOString(), server: 'coding-sessions',
    }] as ExecutorLocalMcpReport
    await report(client, world, ticket, unasked)
    await report(client, world, ticket, undefined)
    assert.deepEqual(await keysOf(client, ticket.workId), [])
    assert.deepEqual((await client.agentTicketWork.findUniqueOrThrow({ where: { id: ticket.workId } })).sessionIds,
      [ticket.sessionId])
  })
})

runDatabaseTest('a turn that ends while the work is parked is skipped, and a wake counts against the ticket\'s wakes', async () => {
  await withTicket(async (world, client, ticket) => {
    const session = (turn: number) =>
      bridgeReport([{ ownerKey: ticket.ownerKey, sessionId: ticket.sessionId, status: 'waiting_for_input', turn }])
    const seen = new Set<string>()
    await moveTo(client, world, ticket.taskId, world.columns.review)
    await report(client, world, ticket, session(1))
    await drainSessionJobs(client, ticket.workId, seen)
    const parked = await client.agentTriggerDelivery.findFirstOrThrow({
      where: { dedupeKey: `session:${ticket.sessionId}:1:waiting_for_input`, triggerId: world.triggerId },
    })
    assert.deepEqual([parked.status, parked.errorMessage], ['skipped', 'no_longer_applies'])

    // Back to work, with the wakes used up: the turn's wake stops the work instead.
    await client.agentTicketWork.update({ where: { id: ticket.workId }, data: { status: 'active', wakeCount: 30 } })
    await report(client, world, ticket, session(2))
    await drainSessionJobs(client, ticket.workId, seen)
    const stopped = await client.agentTicketWork.findUniqueOrThrow({ where: { id: ticket.workId } })
    assert.deepEqual([stopped.status, stopped.stateReason], ['failed', 'limit_wakes'])
  })
})
