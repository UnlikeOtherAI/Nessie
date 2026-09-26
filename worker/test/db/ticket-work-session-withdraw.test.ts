import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@prisma/client'
import { ticketWorkCodingSessionContext } from '@nessie/schemas'

import { bridgeReport } from '../../../packages/team-admin/test/standing-policy-binding-fixture.js'
import {
  drainSessionJobs,
  finishRuns,
  reportFrom,
  sessionJobs,
  withMachinesWorld,
  workingTicket,
  type MachinesWorld,
  type WorkingTicket,
} from './ticket-work-machines-fixture.js'
import { dispatchTicketWorkSession } from '../../src/control/ticket-work-session-wake.js'
import { ticketWorkCodingObserver, type TicketWorkCodingScope } from '../../src/run/ticket-work-coding-sessions.js'
import { runDatabaseTest } from './support.js'

/**
 * What the agent already knows never wakes it, against Postgres (T5;
 * docs/standards/ticket-work-machine-access.md → "A ticket's coding session
 * wakes its work"): a turn its own wait read while the turn's wake still
 * pended behind that run is withdrawn — the delivery skipped, its thread row
 * gone, and the wake given back when nothing else was in the kickoff; an
 * interruption wakes however far the agent had read; and a session the agent
 * closed itself leaves the record, so its close wakes nobody, even from a
 * report that raced the close — whichever of the machine's report, its job
 * and the close's own answer lands first.
 */

const recordOf = (prisma: PrismaClient, id: string) => prisma.agentTicketWork.findUniqueOrThrow({ where: { id } })

/** The observer a bound run's coding tools write through, for this ticket. */
const observer = (prisma: PrismaClient, world: MachinesWorld, ticket: WorkingTicket) => ticketWorkCodingObserver(prisma, {
  agentId: world.agentId,
  allowedRootNames: ['nessie'],
  codingAgents: ['claude'],
  contextId: ticketWorkCodingSessionContext(world.policyId, ticket.taskId),
  executorId: ticket.machine,
  organizationId: world.organizationId,
  ownerKey: ticket.ownerKey,
  policyId: world.policyId,
  runId: randomUUID(),
  taskId: ticket.taskId,
  title: 'Fix login redirect',
  workId: ticket.workId,
} satisfies TicketWorkCodingScope)

runDatabaseTest('a turn the agent\'s own wait read while its wake pended is withdrawn, and the wake given back', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const ticket = await workingTicket(prisma, world)
    const seen = new Set<string>()
    const turn = (n: number, status = 'waiting_for_input') => bridgeReport([
      { ownerKey: ticket.ownerKey, sessionId: ticket.sessionId, status, turn: n },
    ])
    // The agent's run is still going when the machine reports turn 3 ended.
    await prisma.run.create({ data: { agentId: world.agentId, status: 'running', threadId: ticket.threadId } })
    const before = await recordOf(prisma, ticket.workId)
    await reportFrom(prisma, ticket.machine, turn(3, 'working'))
    await reportFrom(prisma, ticket.machine, turn(3))
    await drainSessionJobs(prisma, ticket.workId, seen)
    const pending = await prisma.runThreadPendingMessage.findMany({ where: { threadId: ticket.threadId } })
    assert.equal(pending.length, 1, 'the wake pends behind the run')
    assert.equal((await recordOf(prisma, ticket.workId)).wakeCount, before.wakeCount + 1)

    // That run's own wait reads turn 3 ending.
    const observe = observer(prisma, world, ticket)
    await observe('coding_session_wait', {}, { sessionId: ticket.sessionId, status: 'waiting_for_input', turn: 3 })
    assert.equal(await prisma.runThreadPendingMessage.count({ where: { threadId: ticket.threadId } }), 0)
    assert.equal(await prisma.message.count({ where: { id: pending[0]!.messageId } }), 0, 'its kickoff went with it')
    assert.equal((await recordOf(prisma, ticket.workId)).wakeCount, before.wakeCount, 'the wake is given back')
    const delivery = await prisma.agentTriggerDelivery.findFirstOrThrow({
      where: { dedupeKey: `session:${ticket.sessionId}:3:waiting_for_input`, triggerId: world.triggerId },
    })
    assert.deepEqual([delivery.status, delivery.errorMessage], ['skipped', 'no_longer_applies'])
    assert.equal(await prisma.message.count({
      where: { threadId: ticket.threadId, metadata: { path: ['ticketWorkEvent', 'session', 'sessionId'], equals: ticket.sessionId } },
    }), 0, 'and its row leaves the thread')

    // Turn 4 pends and turn 5 folds into it; reading turn 4 withdraws turn 4 alone.
    await reportFrom(prisma, ticket.machine, turn(4))
    await drainSessionJobs(prisma, ticket.workId, seen)
    await reportFrom(prisma, ticket.machine, turn(5))
    await drainSessionJobs(prisma, ticket.workId, seen)
    await observe('coding_session_wait', {}, { sessionId: ticket.sessionId, status: 'waiting_for_input', turn: 4 })
    const [kept] = await prisma.runThreadPendingMessage.findMany({
      where: { threadId: ticket.threadId }, select: { message: { select: { metadata: true } } },
    })
    const events = (kept?.message.metadata as { ticketWorkKickoff: { events: Array<{ session?: { turn: number } }> } })
      .ticketWorkKickoff.events
    assert.deepEqual(events.map((event) => event.session?.turn), [5])
    assert.equal((await recordOf(prisma, ticket.workId)).wakeCount, before.wakeCount + 1)
  })
})

runDatabaseTest('an interruption wakes however far the agent read, and a session it closed itself wakes nobody', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const ticket = await workingTicket(prisma, world)
    await prisma.agentTicketWork.update({
      where: { id: ticket.workId }, data: { lastObservedTurn: { [ticket.sessionId]: 5 } },
    })
    await reportFrom(prisma, ticket.machine, bridgeReport([
      { ownerKey: ticket.ownerKey, sessionId: ticket.sessionId, status: 'working', turn: 5 },
    ]))
    await reportFrom(prisma, ticket.machine, bridgeReport([
      { ownerKey: ticket.ownerKey, reason: 'max_turn_minutes', sessionId: ticket.sessionId, status: 'interrupted', turn: 5 },
    ]))
    await drainSessionJobs(prisma, ticket.workId, new Set())
    const interrupted = await prisma.agentTriggerDelivery.findFirstOrThrow({
      where: { dedupeKey: `session:${ticket.sessionId}:5:interrupted`, triggerId: world.triggerId },
    })
    assert.equal(interrupted.status, 'delivered', 'the agent read turn 5 end; it did not read the interruption')

    // The agent closes the session itself: it leaves the record, and its close wakes nothing.
    await finishRuns(prisma, ticket.threadId)
    await observer(prisma, world, ticket)('coding_session_close', { sessionId: ticket.sessionId }, {
      sessionId: ticket.sessionId, status: 'closed', turn: 5,
    })
    const closed = await recordOf(prisma, ticket.workId)
    assert.deepEqual(closed.sessionIds, [])
    assert.deepEqual((closed.lastObservedTurn as { closed?: string[] }).closed, [ticket.sessionId])
    await reportFrom(prisma, ticket.machine, bridgeReport([
      { ownerKey: ticket.ownerKey, sessionId: ticket.sessionId, status: 'closed', turn: 5 },
    ]))
    assert.ok(!(await sessionJobs(prisma, ticket.workId)).some((job) => job.idempotencyKey.endsWith(':closed')))
    // A report that raced the close still finds it the agent's own.
    await dispatchTicketWorkSession(prisma, {
      organizationId: world.organizationId, sessionId: ticket.sessionId, status: 'closed', turn: 5, workId: ticket.workId,
    })
    const raced = await prisma.agentTriggerDelivery.findFirstOrThrow({
      where: { dedupeKey: `session:${ticket.sessionId}:5:closed`, triggerId: world.triggerId },
    })
    assert.deepEqual([raced.status, raced.errorMessage], ['skipped', 'no_longer_applies'])
    assert.equal((await recordOf(prisma, ticket.workId)).wakeCount, closed.wakeCount)
  })
})

runDatabaseTest('the agent\'s own close wakes nobody when its machine reports the close before the answer lands', async () => {
  await withMachinesWorld(['Minis'], async (world, prisma) => {
    const ticket = await workingTicket(prisma, world)
    const seen = new Set<string>()
    const observe = observer(prisma, world, ticket)
    /** A session of the ticket's, recorded as its coding tools record a start: on the record, with its origin. */
    const record = async (sessionId: string) => {
      const work = await recordOf(prisma, ticket.workId)
      await prisma.agentTicketWork.update({
        where: { id: ticket.workId },
        data: {
          sessionIds: [...new Set([...work.sessionIds, sessionId])],
          sessionOrigins: {
            ...(work.sessionOrigins as Prisma.JsonObject),
            [sessionId]: { executorId: ticket.machine, policyId: world.policyId, startedAt: new Date().toISOString() },
          } as Prisma.InputJsonObject,
        },
      })
    }
    /** The machine lists the session working, then closed, before the close's own answer is recorded. */
    const reportedClosed = async (sessionId: string) => {
      await reportFrom(prisma, ticket.machine, bridgeReport([{ ownerKey: ticket.ownerKey, sessionId, status: 'working', turn: 2 }]))
      await reportFrom(prisma, ticket.machine, bridgeReport([{ ownerKey: ticket.ownerKey, sessionId, status: 'closed', turn: 2 }]))
      assert.ok(!(await recordOf(prisma, ticket.workId)).sessionIds.includes(sessionId), 'the report let it go')
    }
    const closedDelivery = (sessionId: string) => prisma.agentTriggerDelivery.findFirstOrThrow({
      where: { dedupeKey: `session:${sessionId}:2:closed`, triggerId: world.triggerId },
    })
    await record(ticket.sessionId)
    // The agent's run is closing the session.
    await prisma.run.create({ data: { agentId: world.agentId, status: 'running', threadId: ticket.threadId } })
    const before = await recordOf(prisma, ticket.workId)

    // The report's job runs first: the closed wake pends behind the run. The answer then lands and withdraws it.
    await reportedClosed(ticket.sessionId)
    await drainSessionJobs(prisma, ticket.workId, seen)
    const [pending] = await prisma.runThreadPendingMessage.findMany({ where: { threadId: ticket.threadId } })
    assert.ok(pending, 'the closed wake pends behind the run')
    assert.equal((await recordOf(prisma, ticket.workId)).wakeCount, before.wakeCount + 1)
    await observe('coding_session_close', { sessionId: ticket.sessionId }, {
      sessionId: ticket.sessionId, status: 'closed', turn: 2,
    })
    const withdrawn = await recordOf(prisma, ticket.workId)
    assert.deepEqual((withdrawn.lastObservedTurn as { closed?: string[] }).closed, [ticket.sessionId])
    assert.equal(await prisma.runThreadPendingMessage.count({ where: { threadId: ticket.threadId } }), 0)
    assert.equal(await prisma.message.count({ where: { id: pending.messageId } }), 0, 'its kickoff went with it')
    assert.equal(withdrawn.wakeCount, before.wakeCount, 'the wake is given back')
    const first = await closedDelivery(ticket.sessionId)
    assert.deepEqual([first.status, first.errorMessage], ['skipped', 'no_longer_applies'])
    assert.equal(await prisma.message.count({
      where: { threadId: ticket.threadId, metadata: { path: ['ticketWorkEvent', 'session', 'sessionId'], equals: ticket.sessionId } },
    }), 0, 'and its row leaves the thread')

    // A second session: the answer lands before the report's job runs, and the job finds the close the agent's.
    const second = randomUUID()
    await record(second)
    await reportedClosed(second)
    await observe('coding_session_close', { sessionId: second }, { sessionId: second, status: 'closed', turn: 2 })
    await drainSessionJobs(prisma, ticket.workId, seen)
    const raced = await closedDelivery(second)
    assert.deepEqual([raced.status, raced.errorMessage], ['skipped', 'no_longer_applies'])
    assert.deepEqual((await recordOf(prisma, ticket.workId)).wakeCount, before.wakeCount)
  })
})
