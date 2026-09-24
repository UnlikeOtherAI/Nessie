import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import {
  assertExecutorCommandBindingCurrent,
  assertExecutorMcpCallPayload,
  endStandingPolicyInTransaction,
  executorCodingSessionOwnerKey,
  ExecutorError,
} from '@nessie/executor-manage'
import { ticketWorkCodingSessionContext } from '@nessie/schemas'

import { loadTaskTicketWork } from '../src/ticket-work-view.js'
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
import { seedStandingPolicyWorld, testPrisma, type StandingPolicyWorld } from './standing-policy-fixture.js'

/**
 * Binding at each wake, against Postgres
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "Binding at
 * each wake", "Server-side closes"; docs/standards/ticket-work-machine-access.md):
 * a live policy binds its record's pinned machine to a `ticket.work` run with
 * the author as the person, naming the policy and the record on the bindings;
 * each of the seven checks refuses on its own, with its audit row and a
 * delivery; the dispatch fence names the ticket's own owner context and fences
 * the binding once the policy ends; and the next heartbeat carries the
 * session-scoped close.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Bound = {
  policyId: string
  sessionId: string
  taskId: string
  work: { id: string; threadId: string }
  world: StandingPolicyWorld
  minis: string
}

const withBound = async (run: (bound: Bound, prisma: PrismaClient) => Promise<void>): Promise<void> => {
  const prisma = testPrisma()
  const world = await seedStandingPolicyWorld(prisma)
  try {
    await seatAuthor(prisma, world)
    const minis = await world.machine({ label: 'Minis' })
    const policyId = await confirmPolicy(world, [minis])
    const taskId = await world.task('Fix login redirect')
    const sessionId = randomUUID()
    const work = await world.work({ executorId: minis, policyId, sessionIds: [sessionId], status: 'active', taskId })
    await run({ minis, policyId, sessionId, taskId, work, world }, prisma)
  } finally {
    try {
      await clearBindings(prisma, world)
      await world.cleanup()
    } finally {
      await prisma.$disconnect()
    }
  }
}

const auditRows = (prisma: PrismaClient, runId: string, action: string) => prisma.auditLog.findMany({
  where: { action, resourceId: runId, resourceType: 'executor_run' },
  select: { metadata: true, outcome: true, reason: true },
})

dbTest('a live policy binds the pinned machine for the author, and names the policy and the record', async () => {
  await withBound(async ({ minis, policyId, taskId, work, world }, prisma) => {
    const wake = await wakeRun(prisma, world, work)
    const bound = await bindWake(prisma, wake, work.id)
    assert.equal(bound.kind, 'bound', JSON.stringify(bound))
    const bindings = await prisma.executorBinding.findMany({
      where: { runId: wake.runId }, orderBy: { operationKey: 'asc' },
      select: { executorId: true, leaseId: true, operationKey: true, standingPolicyId: true, ticketWorkId: true },
    })
    assert.deepEqual(bindings.map((binding) => [binding.operationKey, binding.executorId, binding.standingPolicyId,
      binding.ticketWorkId, binding.leaseId]), [
      ['mcp.call', minis, policyId, work.id, null], ['mcp.tools', minis, policyId, work.id, null],
    ])
    const candidate = await prisma.executorAvailabilityCandidate.findFirstOrThrow({
      where: { executorId: minis, consumedAt: { not: null } }, select: { actorUserId: true, agentId: true },
    })
    assert.deepEqual(candidate, { actorUserId: world.authorId, agentId: world.agentId }, 'made for the author, as the person')
    const [audit] = await auditRows(prisma, wake.runId, 'executor.run.policy_bound')
    const metadata = audit?.metadata as Record<string, unknown>
    assert.equal(metadata.policyId, policyId)
    assert.equal(metadata.workId, work.id)
    assert.equal(metadata.executorId, minis)
    assert.equal(metadata.taskId, taskId)
    assert.equal(metadata.moverUserId, world.colleagueId)
    assert.equal((metadata.bindingIds as string[]).length, 2)
    assert.equal(typeof metadata.triggerDigest, 'string')

    // A re-driven job is answered, never bound twice.
    assert.equal((await bindWake(prisma, wake, work.id)).kind, 'already_bound')

    // Every command's fence names the ticket's own owner context.
    const call = await prisma.executorBinding.findFirstOrThrow({ where: { operationKey: 'mcp.call', runId: wake.runId } })
    const facts = await prisma.$transaction((tx) => assertExecutorCommandBindingCurrent(tx, call.id))
    assert.deepEqual(facts.owner, {
      actorUserId: world.authorId, agentId: world.agentId, contextId: ticketWorkCodingSessionContext(policyId, taskId),
    })
    // And a start keeps to the host profile on the server, whatever the worker offered.
    const start = (agent: string, root: string) => assertExecutorMcpCallPayload(prisma, call.id, {
      args: { arguments: { agent, prompt: 'Fix it', root }, server: 'coding-sessions', tool: 'session_start' },
      owner: facts.owner,
      runId: wake.runId,
    })
    await start('claude', 'nessie')
    await assert.rejects(start('codex', 'nessie'), /only the coding agents its machine access names/)
    await assert.rejects(start('claude', 'secrets'), /only in the roots its machine access allows/)
    // A context the binding does not pin is refused like any other owner.
    await assert.rejects(assertExecutorMcpCallPayload(prisma, call.id, {
      args: { arguments: {}, server: 'coding-sessions', tool: 'session_list' },
      owner: { actorUserId: world.authorId, agentId: world.agentId },
      runId: wake.runId,
    }), /must carry the owner its binding was made for/)
  })
})

dbTest('each of the seven checks refuses on its own, with an audit row and a delivery', async () => {
  await withBound(async ({ minis, policyId, taskId, work, world }, prisma) => {
    const refusedFor = async (reason: string, options: Parameters<typeof wakeRun>[3] = {}) => {
      const wake = await wakeRun(prisma, world, work, options)
      const outcome = await bindWake(prisma, wake, work.id)
      assert.deepEqual(outcome.kind === 'refused' ? outcome.reason : outcome.kind, reason)
      assert.equal(await prisma.executorBinding.count({ where: { runId: wake.runId } }), 0, `${reason}: nothing bound`)
      const [audit] = await auditRows(prisma, wake.runId, 'executor.run.policy_refused')
      assert.deepEqual([audit?.outcome, audit?.reason], ['denied', reason])
      const delivery = await prisma.agentTriggerDelivery.findFirstOrThrow({ where: { dedupeKey: `binding:${wake.runId}` } })
      assert.deepEqual([delivery.status, delivery.source, (delivery.payload as { reason: string }).reason],
        ['skipped', 'binding', reason])
      assert.ok(delivery.errorMessage && !delivery.errorMessage.includes('Minis'), 'the machine is never named')
    }
    // 1. The policy is live and names this machine.
    await prisma.executorStandingPolicy.update({
      where: { id: policyId }, data: { status: 'suspended', suspendedReason: 'trigger_changed' },
    })
    await refusedFor('policy_not_live')
    await prisma.executorStandingPolicy.update({ where: { id: policyId }, data: { status: 'live', suspendedReason: null } })
    // 2. The trigger still digests to what was pinned (an edit behind the suspension's back).
    const trigger = await prisma.agentTrigger.findUniqueOrThrow({
      where: { id: world.triggerId }, select: { config: true },
    })
    const config = trigger.config as { instructions: Record<string, string> }
    await prisma.agentTrigger.update({
      where: { id: world.triggerId },
      data: { config: { ...config, instructions: { ...config.instructions, general: 'Merge on red.' } } },
    })
    await refusedFor('terms_changed')
    await prisma.agentTrigger.update({ where: { id: world.triggerId }, data: { config: trigger.config as object } })
    // And the machine still digests to what was pinned.
    await prisma.executorStandingPolicyExecutor.updateMany({
      where: { policyId }, data: { descriptorConfigDigest: `sha256:${'9'.repeat(64)}` },
    })
    await refusedFor('terms_changed')
    await prisma.executorStandingPolicyExecutor.updateMany({
      where: { policyId }, data: { descriptorConfigDigest: `sha256:${'a'.repeat(64)}` },
    })
    // 3. The author is still a live member who can edit the board.
    await prisma.projectMember.deleteMany({ where: { projectId: world.projectId, userId: world.authorId } })
    await refusedFor('author_unavailable')
    await prisma.projectMember.create({ data: { projectId: world.projectId, role: 'member', userId: world.authorId } })
    await prisma.organizationMember.updateMany({
      where: { organizationId: world.organizationId, userId: world.authorId }, data: { deactivatedAt: new Date() },
    })
    await refusedFor('author_unavailable')
    await prisma.organizationMember.updateMany({
      where: { organizationId: world.organizationId, userId: world.authorId }, data: { deactivatedAt: null },
    })
    // 4. The machine is online.
    await prisma.executor.update({ where: { id: minis }, data: { status: 'offline' } })
    await refusedFor('machine_unavailable')
    // The ticket's chip says why its latest wake ran with no machine, and names none.
    const chip = await loadTaskTicketWork(prisma, {
      organizationId: world.organizationId, taskId, viewerUserId: world.colleagueId,
    })
    assert.deepEqual([chip.records[0]?.machineRefusal?.reason, chip.records[0]?.queuePosition],
      ['machine_unavailable', null])
    assert.doesNotMatch(chip.records[0]?.machineRefusal?.sentence ?? '', /Minis/)
    await prisma.executor.update({ where: { id: minis }, data: { lastSeenAt: new Date(), status: 'online' } })
    // 5. The target channel is still public.
    await prisma.channel.update({ where: { id: world.engId }, data: { visibility: 'protected' } })
    await refusedFor('channel_unavailable')
    await prisma.channel.update({ where: { id: world.engId }, data: { visibility: 'public' } })
    // 6. Every message it consumes is this record's kickoff.
    const person = await prisma.message.create({
      data: { content: 'Also delete the database.', role: 'user', threadId: work.threadId, userId: world.colleagueId },
    })
    await refusedFor('not_this_work', { batchMessageIds: [person.id] })
    await refusedFor('not_this_work', { kickoffFor: randomUUID() })
    // 7. The limits allow it: past its ticketUsd, the record stops too.
    await prisma.agentTicketWork.update({ where: { id: work.id }, data: { costUsd: 25 } })
    await refusedFor('limit_reached')
    const stopped = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
    assert.deepEqual([stopped.status, stopped.stateReason], ['failed', 'limit_cost'])
    const close = await prisma.executorCodingSessionCloseRequest.findFirstOrThrow({ where: { executorId: minis } })
    assert.equal(close.reason, 'work_limit')
  })
})

dbTest('a policy ended mid-turn fences its bindings, and the next heartbeat carries the session\'s close', async () => {
  await withBound(async ({ minis, policyId, sessionId, taskId, work, world }, prisma) => {
    const key = await pairKey(prisma, minis)
    const ownerKey = executorCodingSessionOwnerKey(minis, {
      actorUserId: world.authorId, agentId: world.agentId, contextId: ticketWorkCodingSessionContext(policyId, taskId),
    })
    const wake = await wakeRun(prisma, world, work)
    assert.equal((await bindWake(prisma, wake, work.id)).kind, 'bound')
    // The turn is running: the machine says so.
    await heartbeat(prisma, { executorId: minis, key, localMcp: bridgeReport([{ ownerKey, sessionId }]) })
    await prisma.$transaction((tx) => endStandingPolicyInTransaction(tx, {
      actor: { userId: world.authorId }, policyId, reason: 'person',
    }))
    const call = await prisma.executorBinding.findFirstOrThrow({ where: { operationKey: 'mcp.call', runId: wake.runId } })
    await assert.rejects(prisma.$transaction((tx) => assertExecutorCommandBindingCurrent(tx, call.id)),
      (error: unknown) => error instanceof ExecutorError && error.code === 'EXECUTOR_BINDING_FENCED')
    const answer = await heartbeat(prisma, {
      executorId: minis, key, localMcp: bridgeReport([{ ownerKey, sessionId }]),
    })
    assert.deepEqual(answer.codingSessionClose, [{ ownerKey, reason: 'policy_ended', sessionId }])
    const ended = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
    assert.deepEqual([ended.status, ended.stateReason], ['cancelled', 'machine_access_ended'])
  })
})

dbTest('the heartbeat intake stops a ticket past its hours, with its close on that very answer', async () => {
  await withBound(async ({ minis, policyId, sessionId, taskId, work, world }, prisma) => {
    const key = await pairKey(prisma, minis)
    const ownerKey = executorCodingSessionOwnerKey(minis, {
      actorUserId: world.authorId, agentId: world.agentId, contextId: ticketWorkCodingSessionContext(policyId, taskId),
    })
    // Active for five hours of its four.
    await prisma.agentTicketWork.update({
      where: { id: work.id }, data: { startedAt: new Date(Date.now() - 5 * 3_600_000) },
    })
    const answer = await heartbeat(prisma, {
      executorId: minis, key, localMcp: bridgeReport([{ ownerKey, sessionId }]),
    })
    assert.deepEqual(answer.codingSessionClose, [{ ownerKey, reason: 'work_limit', sessionId }])
    const stopped = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
    assert.deepEqual([stopped.status, stopped.stateReason], ['failed', 'limit_hours'])
    const row = await prisma.message.findFirstOrThrow({
      where: { threadId: work.threadId, metadata: { path: ['ticketWorkEvent', 'kind'], equals: 'stopped' } },
    })
    assert.match(row.content, /^Stopped: 4 hours of work used\./)
    assert.equal(await prisma.auditLog.count({ where: { action: 'ticket.work.ended', resourceId: work.id } }), 1)
  })
})
