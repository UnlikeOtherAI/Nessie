import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import {
  bindStandingPolicyExecutor,
  endStandingPolicyInTransaction,
  enforceTicketWorkLimitsInTransaction,
  executorCodingSessionOwnerKey,
  placeTicketWorkOnMachineInTransaction,
  suspendStandingPolicyInTransaction,
  utcDay,
} from '@nessie/executor-manage'
import { ticketWorkCodingSessionContext } from '@nessie/schemas'

import { updateAgentRecord } from '../src/agent-update.js'
import { setAgentToolPolicyKeys } from '../src/agent-tool-policy.js'
import { canMemberEditProjectBoards } from '../src/resource-authority.js'
import { ticketInWorkFlow } from '../src/ticket-work-lock.js'
import {
  bindWake,
  bridgeReport,
  clearBindings,
  confirmPolicy,
  heartbeat,
  pairKey,
  seatAuthor,
  wakeRun,
} from './standing-policy-binding-fixture.js'
import {
  CODING_FACTS,
  seedStandingPolicyWorld,
  testPrisma,
  type StandingPolicyWorld,
} from './standing-policy-fixture.js'

/**
 * Standing machine access after its security and follow-through reviews,
 * against Postgres (docs/standards/ticket-work-machine-access.md): the agent
 * is pinned with the trigger, so an edit of it — in its own transaction, or
 * behind it — suspends the policy (`agent_changed`); the binder refuses a
 * ticket out of its flow, re-checks a re-driven job and fences its earlier
 * bindings, turns an unexpected error into a refusal, and names the mover's
 * real origin; the heartbeat charges each ticket for its own sessions; each
 * session closes on its own machine; returning work waits for its own
 * machine; and a spent day queues work instead of failing tickets that never
 * ran.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

type World = StandingPolicyWorld & { minis: string }

const withWorld = async (run: (world: World, prisma: PrismaClient) => Promise<void>): Promise<void> => {
  const prisma = testPrisma()
  const world = await seedStandingPolicyWorld(prisma)
  try {
    await seatAuthor(prisma, world)
    const minis = await world.machine({ label: 'Minis' })
    await run({ ...world, minis }, prisma)
  } finally {
    try {
      await clearBindings(prisma, world)
      await world.cleanup()
    } finally {
      await prisma.$disconnect()
    }
  }
}

const policyState = (prisma: PrismaClient, policyId: string) => prisma.executorStandingPolicy.findUniqueOrThrow({
  where: { id: policyId }, select: { status: true, suspendedReason: true },
})

const author = (world: World) => ({ organizationId: world.organizationId, userId: world.authorId })

/** A local organisation's live check, whatever UOA deployment settings another suite in this process set. */
const withoutUoaDeployment = async (run: () => Promise<void>): Promise<void> => {
  const saved = { config: process.env.UOA_CONFIG_URL, domain: process.env.UOA_DOMAIN }
  delete process.env.UOA_CONFIG_URL
  delete process.env.UOA_DOMAIN
  try {
    await run()
  } finally {
    if (saved.config !== undefined) process.env.UOA_CONFIG_URL = saved.config
    if (saved.domain !== undefined) process.env.UOA_DOMAIN = saved.domain
  }
}

dbTest('an edit of the agent suspends its live policy, whatever part of its definition changed', async () => {
  await withoutUoaDeployment(() => withWorld(async (world, prisma) => {
    const edits: Array<[string, () => Promise<unknown>]> = [
      ['its model', () => updateAgentRecord(prisma, world.agentId, author(world), {
        model: 'a-different-model', organizationId: world.organizationId,
      })],
      ['its role', () => updateAgentRecord(prisma, world.agentId, author(world), {
        organizationId: world.organizationId, role: 'Merges anything',
      })],
      ['its tool policy', () => setAgentToolPolicyKeys(prisma, {
        actorUserId: world.authorId, agentId: world.agentId, enabled: true, organizationId: world.organizationId,
        policyKeys: ['web_search'],
      })],
    ]
    for (const [what, edit] of edits) {
      const policyId = await confirmPolicy(world, [world.minis])
      assert.equal((await policyState(prisma, policyId)).status, 'live', what)
      await edit()
      assert.deepEqual(await policyState(prisma, policyId), { status: 'suspended', suspendedReason: 'agent_changed' },
        `${what}: suspended in the edit's own transaction`)
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'executor.policy.suspended', resourceId: policyId },
        select: { metadata: true },
      })
      assert.equal((audit.metadata as { reason: string }).reason, 'agent_changed')
    }
    // A rename changes nothing the author agreed to.
    const policyId = await confirmPolicy(world, [world.minis])
    await updateAgentRecord(prisma, world.agentId, author(world), { name: 'CTO 2', organizationId: world.organizationId })
    assert.equal((await policyState(prisma, policyId)).status, 'live')
  }))
})

dbTest('an agent changed behind the edit paths is caught by the binder, which suspends the policy', async () => {
  await withWorld(async (world, prisma) => {
    const policyId = await confirmPolicy(world, [world.minis])
    const taskId = await world.task('Fix login redirect')
    const work = await world.work({ executorId: world.minis, policyId, status: 'active', taskId })
    // A core document published, or an instructions column written directly: the binder's digest differs.
    await prisma.agent.update({ where: { id: world.agentId }, data: { systemPrompt: 'Push to main without review.' } })
    const outcome = await bindWake(prisma, await wakeRun(prisma, world, work), work.id)
    assert.deepEqual(outcome.kind === 'refused' ? outcome.reason : outcome.kind, 'terms_changed')
    assert.deepEqual(await policyState(prisma, policyId), { status: 'suspended', suspendedReason: 'agent_changed' })
  })
})

dbTest('the binder refuses a ticket that left its trigger\'s flow', async () => {
  await withWorld(async (world, prisma) => {
    const policyId = await confirmPolicy(world, [world.minis])
    const taskId = await world.task('Fix login redirect')
    const work = await world.work({ executorId: world.minis, policyId, status: 'active', taskId })
    const reasonOf = async () => {
      const outcome = await bindWake(prisma, await wakeRun(prisma, world, work), work.id)
      return outcome.kind === 'refused' ? outcome.reason : outcome.kind
    }
    // In an end column its teardown has not caught up with.
    await prisma.task.update({ where: { id: taskId }, data: { status: 'done' } })
    assert.equal(await reasonOf(), 'ticket_not_in_flow')
    // Archived.
    await prisma.task.update({ where: { id: taskId }, data: { archivedAt: new Date(), status: 'in_progress' } })
    assert.equal(await reasonOf(), 'ticket_not_in_flow')
    // Moved to another board.
    const other = await prisma.board.create({
      data: { name: 'Elsewhere', organizationId: world.organizationId, position: 1, projectId: world.projectId },
    })
    await prisma.boardColumn.create({
      data: { boardId: other.id, category: 'in_progress', name: 'Doing', organizationId: world.organizationId, position: 0 },
    })
    await prisma.task.update({ where: { id: taskId }, data: { archivedAt: null, boardId: other.id } })
    assert.equal(await reasonOf(), 'ticket_not_in_flow')
    await prisma.task.update({ where: { id: taskId }, data: { boardId: null } })
    assert.equal(await reasonOf(), 'bound')
  })
})

dbTest('a re-driven job is checked again, and when a check fails its earlier bindings are fenced', async () => {
  await withWorld(async (world, prisma) => {
    const policyId = await confirmPolicy(world, [world.minis])
    const taskId = await world.task('Fix login redirect')
    const work = await world.work({ executorId: world.minis, policyId, status: 'active', taskId })
    const wake = await wakeRun(prisma, world, work)
    assert.equal((await bindWake(prisma, wake, work.id)).kind, 'bound')
    await prisma.projectMember.deleteMany({ where: { projectId: world.projectId, userId: world.authorId } })
    const retried = await bindWake(prisma, wake, work.id)
    assert.deepEqual(retried.kind === 'refused' ? retried.reason : retried.kind, 'author_unavailable')
    const bindings = await prisma.executorBinding.findMany({ where: { runId: wake.runId }, select: { standingPolicyId: true } })
    assert.equal(bindings.length, 2)
    assert.ok(bindings.every((binding) => binding.standingPolicyId === null), 'fenced: no policy left on them')
  })
})

dbTest('an unexpected error while binding is a refusal the run and the Triggers page are told of', async () => {
  await withWorld(async (world, prisma) => {
    const policyId = await confirmPolicy(world, [world.minis])
    const taskId = await world.task('Fix login redirect')
    const work = await world.work({ executorId: world.minis, policyId, status: 'active', taskId })
    const wake = await wakeRun(prisma, world, work)
    const outcome = await bindStandingPolicyExecutor(prisma, { job: wake.job, runId: wake.runId }, { workId: work.id }, {
      canEditBoard: (check) => canMemberEditProjectBoards(prisma, check),
      entitlements: { settings: null, uoaConfigured: false },
      ticketInFlow: async () => { throw new Error('connection reset') },
    })
    assert.deepEqual(outcome.kind === 'refused' ? outcome.reason : outcome.kind, 'bind_failed')
    const delivery = await prisma.agentTriggerDelivery.findFirstOrThrow({ where: { dedupeKey: `binding:${wake.runId}` } })
    assert.equal((delivery.payload as { reason: string }).reason, 'bind_failed')
    assert.match(delivery.errorMessage ?? '', /the machine could not be reached this turn/)
    assert.equal(await prisma.auditLog.count({
      where: { action: 'executor.run.policy_refused', reason: 'bind_failed', resourceId: wake.runId },
    }), 1)
  })
})

dbTest('the bound audit names the real origin of the move that started the work', async () => {
  await withWorld(async (world, prisma) => {
    const policyId = await confirmPolicy(world, [world.minis])
    const taskId = await world.task('Fix login redirect')
    const event = await prisma.taskEvent.create({
      data: { eventType: 'column_entered', payload: { origin: { keyId: 'key-1', kind: 'token' } }, taskId },
    })
    const work = await world.work({ executorId: world.minis, policyId, status: 'active', taskId })
    await prisma.agentTicketWork.update({ where: { id: work.id }, data: { startedByEventId: event.id } })
    const wake = await wakeRun(prisma, world, work)
    assert.equal((await bindWake(prisma, wake, work.id)).kind, 'bound')
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'executor.run.policy_bound', resourceId: wake.runId }, select: { metadata: true },
    })
    assert.deepEqual((audit.metadata as { moverOrigin: unknown }).moverOrigin, { keyId: 'key-1', kind: 'token' })
  })
})

dbTest('the heartbeat charges each ticket for its own sessions, and stops one past its ticketUsd', async () => {
  await withWorld(async (world, prisma) => {
    const policyId = await confirmPolicy(world, [world.minis])
    const taskId = await world.task('Fix login redirect')
    const sessionId = randomUUID()
    const work = await world.work({ executorId: world.minis, policyId, sessionIds: [sessionId], status: 'active', taskId })
    const key = await pairKey(prisma, world.minis)
    const ownerKey = executorCodingSessionOwnerKey(world.minis, {
      actorUserId: world.authorId, agentId: world.agentId, contextId: ticketWorkCodingSessionContext(policyId, taskId),
    })
    const otherKey = executorCodingSessionOwnerKey(world.minis, {
      actorUserId: world.authorId, agentId: world.agentId, contextId: ticketWorkCodingSessionContext(policyId, randomUUID()),
    })
    const report = (totalCostUsd: number) => bridgeReport([
      { ownerKey, sessionId, totalCostUsd },
      // Another ticket's session on the same machine is never this ticket's spend.
      { ownerKey: otherKey, sessionId: randomUUID(), totalCostUsd: 99 },
    ])
    const spent = async () => {
      const [record, day] = await Promise.all([
        prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } }),
        prisma.executorStandingPolicyDailySpend.findUnique({
          where: { policyId_day: { day: utcDay(new Date()), policyId } },
        }),
      ])
      return [Number(record.costUsd), Number(day?.costUsd ?? 0), record.status]
    }
    await heartbeat(prisma, { executorId: world.minis, key, localMcp: report(3) })
    assert.deepEqual(await spent(), [3, 3, 'active'], 'charged with no run reading the session')
    await heartbeat(prisma, { executorId: world.minis, key, localMcp: report(3) })
    assert.deepEqual(await spent(), [3, 3, 'active'], 'the same total is counted once')
    const answer = await heartbeat(prisma, { executorId: world.minis, key, localMcp: report(25) })
    assert.deepEqual(await spent(), [25, 25, 'failed'])
    assert.deepEqual(answer.codingSessionClose, [{ ownerKey, reason: 'work_limit', sessionId }])
  })
})

dbTest('each session closes on the machine it was started on, whichever machine the record holds now', async () => {
  await withWorld(async (world, prisma) => {
    const studio = await world.machine({ label: 'Studio' })
    const policyId = await confirmPolicy(world, [world.minis, studio])
    const taskId = await world.task('Fix login redirect')
    const [first, second] = [randomUUID(), randomUUID()]
    const work = await world.work({ executorId: studio, policyId, sessionIds: [first, second], status: 'active', taskId })
    const startedAt = new Date().toISOString()
    await prisma.agentTicketWork.update({
      where: { id: work.id },
      data: {
        sessionOrigins: {
          [first]: { executorId: world.minis, policyId, startedAt },
          [second]: { executorId: studio, policyId, startedAt },
        },
      },
    })
    await prisma.$transaction((tx) => endStandingPolicyInTransaction(tx, {
      actor: { userId: world.authorId }, policyId, reason: 'person',
    }))
    const closes = await prisma.executorCodingSessionCloseRequest.findMany({
      where: { executorId: { in: [world.minis, studio] } }, select: { executorId: true, sessionId: true },
    })
    assert.deepEqual(closes.map((close) => [close.executorId, close.sessionId]).sort(),
      [[world.minis, first], [studio, second]].sort())
  })
})

dbTest('returning work goes back to its own machine while it could take it, and to another once it is held', async () => {
  await withWorld(async (world, prisma) => {
    const studio = await world.machine({ label: 'Studio' })
    const policyId = await confirmPolicy(world, [world.minis, studio])
    const place = (workId: string) => prisma.$transaction((tx) => placeTicketWorkOnMachineInTransaction(tx, { workId }))
    // It last worked on Studio, the pool's second machine, which is free: it goes back there.
    const back = await world.work({ executorId: studio, policyId, status: 'parked', taskId: await world.task('Back') })
    const home = await place(back.id)
    assert.deepEqual(home.kind === 'assigned' ? home.executorId : home.kind, studio)
    // Another ticket's session was started on Studio, which is now held: it takes Minis rather than wait,
    // and the session it leaves on Studio closes there (`machine_reassigned`) and leaves its live set.
    const sessionId = randomUUID()
    const other = await world.work({ policyId, sessionIds: [sessionId], status: 'parked', taskId: await world.task('Other') })
    await prisma.agentTicketWork.update({
      where: { id: other.id },
      data: { sessionOrigins: { [sessionId]: { executorId: studio, policyId, startedAt: new Date().toISOString() } } },
    })
    const moved = await place(other.id)
    assert.deepEqual(moved.kind === 'assigned' ? moved.executorId : moved.kind, world.minis, 'it never waits for a held machine')
    const closes = await prisma.executorCodingSessionCloseRequest.findMany({
      where: { executorId: studio, sessionId }, select: { reason: true },
    })
    assert.deepEqual(closes, [{ reason: 'machine_reassigned' }])
    const record = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: other.id } })
    assert.deepEqual(record.sessionIds, [])
    assert.ok((record.sessionOrigins as Record<string, unknown>)[sessionId], 'its origin stays, so it is charged until it closes')
  })
})

dbTest('a spent day queues new work, and fails only work that is running', async () => {
  await withWorld(async (world, prisma) => {
    const studio = await world.machine({ label: 'Studio' })
    const policyId = await confirmPolicy(world, [world.minis, studio])
    const running = await world.work({ executorId: world.minis, policyId, status: 'active', taskId: await world.task('A') })
    const waiting = await world.work({ policyId, status: 'queued', taskId: await world.task('B') })
    const parked = await world.work({ executorId: studio, policyId, status: 'parked', taskId: await world.task('C') })
    await prisma.executorStandingPolicyDailySpend.create({ data: { costUsd: 60, day: utcDay(new Date()), policyId } })
    await prisma.$transaction((tx) => enforceTicketWorkLimitsInTransaction(tx, { where: { policyId } }))
    const status = async (id: string) => (await prisma.agentTicketWork.findUniqueOrThrow({
      where: { id }, select: { stateReason: true, status: true },
    }))
    assert.deepEqual(await status(running.id), { stateReason: 'limit_cost', status: 'failed' })
    assert.deepEqual((await status(waiting.id)).status, 'queued', 'never ran: not failed')
    assert.deepEqual((await status(parked.id)).status, 'parked')
    const placed = await prisma.$transaction((tx) => placeTicketWorkOnMachineInTransaction(tx, { workId: waiting.id }))
    assert.deepEqual([placed.kind, placed.kind === 'queued' ? placed.reason : null], ['queued', 'queued_daily_limit'])
    assert.deepEqual(await status(waiting.id), { stateReason: 'queued_daily_limit', status: 'queued' })
  })
})

dbTest('Claude Code that may run any command unasked needs the tick, and an executor too old to say so is refused', async () => {
  await withWorld(async (world) => {
    const wide = await world.machine({ codingSessions: { ...CODING_FACTS, unaskedCommands: 'any' }, label: 'Wide' })
    await assert.rejects(world.prepare({ executorIds: [wide] }), (error: unknown) => {
      const refusal = error as { machines?: Array<{ reason: string; sentence: string }> }
      assert.equal(refusal.machines?.[0]?.reason, 'bypass_not_allowed')
      assert.match(refusal.machines?.[0]?.sentence ?? '', /its configuration allows every Bash command/)
      return true
    })
    const prepared = await world.prepare({ allowAnyCommand: true, executorIds: [wide] })
    assert.match(JSON.stringify(prepared.card), /Claude Code may run any command without asking on Wide/)
    const older = Object.fromEntries(Object.entries(CODING_FACTS).filter(([key]) => key !== 'unaskedCommands'))
    const old = await world.machine({ codingSessions: older, label: 'Old' })
    await assert.rejects(world.prepare({ executorIds: [old] }), (error: unknown) => {
      assert.equal((error as { machines?: Array<{ reason: string }> }).machines?.[0]?.reason, 'older_executor')
      return true
    })
  })
})

dbTest('the flow check reads the ticket where it renders', async () => {
  await withWorld(async (world, prisma) => {
    const trigger = await prisma.agentTrigger.findUniqueOrThrow({ where: { id: world.triggerId }, select: { config: true } })
    const taskId = await world.task('Fix login redirect')
    assert.equal(await ticketInWorkFlow(prisma, { boardId: world.board, config: trigger.config, taskId }), true)
    assert.equal(await ticketInWorkFlow(prisma, { boardId: randomUUID(), config: trigger.config, taskId }), false)
    assert.equal(await ticketInWorkFlow(prisma, { boardId: world.board, config: { nonsense: true }, taskId }), false)
  })
})

dbTest('a placement racing a suspension waits for the pool it locks, and places nothing under it', async () => {
  await withWorld(async (world, prisma) => {
    const policyId = await confirmPolicy(world, [world.minis])
    const waiting = await world.work({ policyId, status: 'queued', taskId: await world.task('Fix login redirect') })
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    let suspended: () => void = () => undefined
    const suspending = new Promise<void>((resolve) => { suspended = resolve })
    // The suspension takes the pool's locks and holds its transaction open.
    const suspension = prisma.$transaction(async (tx) => {
      await suspendStandingPolicyInTransaction(tx, {
        actor: { userId: world.authorId }, detail: { changed: ['the agent'] }, policyId, reason: 'agent_changed',
      })
      suspended()
      await held
    }, { timeout: 20_000 })
    await suspending
    // The placement read the policy before the suspension committed; it waits for the pool, then reads it again.
    const placing = prisma.$transaction((tx) => placeTicketWorkOnMachineInTransaction(tx, { workId: waiting.id }),
      { timeout: 20_000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    release()
    const [, placed] = await Promise.all([suspension, placing])
    assert.deepEqual([placed.kind, placed.kind === 'waiting' ? placed.reason : null], ['waiting', 'machine_access_suspended'])
    const record = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: waiting.id } })
    assert.deepEqual([record.status, record.executorId], ['waiting_machine', null], 'nothing placed under a suspended policy')
  })
})
