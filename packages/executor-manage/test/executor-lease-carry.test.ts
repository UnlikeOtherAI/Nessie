import assert from 'node:assert/strict'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'

import { carryForwardExecutorBindings } from '../src/index.js'
import {
  auditRows,
  createRun,
  jobFor,
  launchLocalApps,
  leaseRow,
  postMessage,
  seedLeaseWorld,
  type LeaseWorld,
} from './lease-fixture.js'

/**
 * Who may carry a conversation lease into a later run, against a real
 * database: the structural definition of "initiated by that person"
 * (docs/plans/2026-09-22-executor-local-apps/conversation-lease.md §2 and §8).
 * Every refusal binds nothing; every carry binds afresh, under the lease.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

const withWorld = async (
  run: (world: LeaseWorld) => Promise<void>,
  options: { agentConversation?: boolean } = {},
): Promise<void> => {
  const prisma = new PrismaClient()
  const world = await seedLeaseWorld(prisma, options)
  try {
    await run(world)
  } finally {
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
}

const bindingsOf = (world: LeaseWorld, runId: string) => world.prisma.executorBinding.findMany({
  where: { runId }, orderBy: { operationKey: 'asc' }, select: { executorId: true, leaseId: true, operationKey: true },
})

dbTest('the holder’s reply in the launch’s reply thread carries, afresh and under the lease', async () => {
  await withWorld(async (world) => {
    const launch = await launchLocalApps(world)
    const before = await leaseRow(world, launch.lease.id)
    assert.deepEqual(
      (await bindingsOf(world, launch.run.id)).map((binding) => binding.leaseId),
      [launch.lease.id, launch.lease.id],
      'the launch’s own bindings belong to the lease, so End stops them too',
    )
    const reply = await postMessage(world, { rootMessageId: launch.message.id })
    const run = await createRun(world, { triggerMessageId: reply.id })
    const outcome = await carryForwardExecutorBindings(world.prisma, {
      job: jobFor(world, { messageId: reply.id, runId: run.id }), runId: run.id,
    })
    assert.equal(outcome.kind, 'carried')
    assert.equal(outcome.kind === 'carried' && outcome.lease.id, launch.lease.id)
    assert.deepEqual(await bindingsOf(world, run.id), [
      { executorId: world.executorId, leaseId: launch.lease.id, operationKey: 'mcp.call' },
      { executorId: world.executorId, leaseId: launch.lease.id, operationKey: 'mcp.tools' },
    ])
    const carriedCandidates = await world.prisma.executorAvailabilityCandidate.count({
      where: { runId: run.id, consumedAt: { not: null } },
    })
    assert.equal(carriedCandidates, 1, 'a fresh candidate pinned to this run was resolved and consumed')
    const after = await leaseRow(world, launch.lease.id)
    assert.ok(after.lastUsedAt > before.lastUsedAt, 'a carry is use')
    assert.ok(after.idleExpiresAt > before.idleExpiresAt)
    assert.equal(after.absoluteExpiresAt.getTime(), before.absoluteExpiresAt.getTime(), 'the absolute cap never moves')

    const [carried] = await auditRows(world, 'executor.run.carried')
    assert.ok(carried, 'the carry is in the audit chain')
    assert.equal(carried.actorId, world.holderId)
    assert.equal(carried.resourceId, run.id)
    const metadata = carried.metadata as Record<string, unknown>
    assert.equal(metadata.leaseId, launch.lease.id)
    assert.equal(metadata.predecessorRunId, launch.run.id)
    assert.equal(metadata.runId, run.id)
    assert.equal(metadata.triggerMessageId, reply.id)
    assert.equal(metadata.actorUserId, world.holderId)
    assert.equal((metadata.bindingIds as string[]).length, 2)
    assert.ok(carried.entryHash, 'written through the chained audit writer')
  })
})

dbTest('the holder’s top-level post elsewhere in the channel starts no carried run', async () => {
  await withWorld(async (world) => {
    await launchLocalApps(world)
    const elsewhere = await postMessage(world, {})
    const run = await createRun(world, { triggerMessageId: elsewhere.id })
    const outcome = await carryForwardExecutorBindings(world.prisma, {
      job: jobFor(world, { messageId: elsewhere.id, runId: run.id }), runId: run.id,
    })
    assert.deepEqual(outcome, { kind: 'no_lease' })
    assert.deepEqual(await bindingsOf(world, run.id), [])
  })
})

dbTest('inside a conversation with the agent, the whole thread is the conversation', async () => {
  await withWorld(async (world) => {
    const launch = await launchLocalApps(world)
    const next = await postMessage(world, {})
    const run = await createRun(world, { triggerMessageId: next.id })
    const outcome = await carryForwardExecutorBindings(world.prisma, {
      job: jobFor(world, { messageId: next.id, runId: run.id }), runId: run.id,
    })
    assert.equal(outcome.kind, 'carried')
    assert.equal(outcome.kind === 'carried' && outcome.lease.id, launch.lease.id)
  }, { agentConversation: true })
})

dbTest('another member’s reply, Continue or Restart carries nothing and says why', async () => {
  await withWorld(async (world) => {
    const launch = await launchLocalApps(world)
    const theirReply = await postMessage(world, { rootMessageId: launch.message.id, userId: world.memberId })
    const replyRun = await createRun(world, { triggerMessageId: theirReply.id })
    assert.deepEqual(await carryForwardExecutorBindings(world.prisma, {
      job: jobFor(world, { actorContext: world.memberContext, messageId: theirReply.id, runId: replyRun.id }),
      runId: replyRun.id,
    }), { kind: 'refused', leaseId: launch.lease.id, reason: 'actor_not_holder' })

    // The holder's own reply ran; now another member presses Continue and
    // Restart on it. Both replay the holder's message but act as the presser.
    const holderReply = await postMessage(world, { rootMessageId: launch.message.id })
    const original = await createRun(world, { triggerMessageId: holderReply.id })
    const continued = await createRun(world, { continuationOfRunId: original.id, triggerMessageId: holderReply.id })
    const restarted = await createRun(world, { restartOfRunId: original.id, triggerMessageId: holderReply.id })
    for (const run of [continued, restarted]) {
      assert.deepEqual(await carryForwardExecutorBindings(world.prisma, {
        job: jobFor(world, { actorContext: world.memberContext, messageId: holderReply.id, runId: run.id }),
        runId: run.id,
      }), { kind: 'refused', leaseId: launch.lease.id, reason: 'actor_not_holder' })
      assert.deepEqual(await bindingsOf(world, run.id), [])
    }

    // The holder pressing Continue is their own follow-up and carries.
    const own = await createRun(world, { continuationOfRunId: original.id, triggerMessageId: holderReply.id })
    const outcome = await carryForwardExecutorBindings(world.prisma, {
      job: jobFor(world, { messageId: holderReply.id, runId: own.id }), runId: own.id,
    })
    assert.equal(outcome.kind, 'carried')
    const [audit] = await auditRows(world, 'executor.run.carried')
    assert.equal((audit?.metadata as Record<string, unknown>).predecessorRunId, original.id)
  })
})

dbTest('a channel-policy authorizer or another effective user is not the holder', async () => {
  await withWorld(async (world) => {
    const launch = await launchLocalApps(world)
    const reply = await postMessage(world, { rootMessageId: launch.message.id })
    const run = await createRun(world, { triggerMessageId: reply.id })
    for (const actorContext of [
      world.contextFor(world.holderId, { purpose: 'channel.policy', effectiveUserId: world.holderId as never }),
      world.contextFor(world.holderId, { effectiveUserId: world.memberId as never }),
    ]) {
      assert.deepEqual(await carryForwardExecutorBindings(world.prisma, {
        job: jobFor(world, { actorContext, messageId: reply.id, runId: run.id }), runId: run.id,
      }), { kind: 'refused', leaseId: launch.lease.id, reason: 'actor_not_holder' })
    }
  })
})

dbTest('a drained batch carries only when every message in it is the holder’s own', async () => {
  await withWorld(async (world) => {
    const launch = await launchLocalApps(world)
    const theirs = await postMessage(world, { rootMessageId: launch.message.id, userId: world.memberId })
    const mine = await postMessage(world, { rootMessageId: launch.message.id })
    const mixed = await createRun(world, { triggerMessageId: mine.id })
    assert.deepEqual(await carryForwardExecutorBindings(world.prisma, {
      job: jobFor(world, { batchMessageIds: [theirs.id, mine.id], messageId: mine.id, runId: mixed.id }),
      runId: mixed.id,
    }), { kind: 'refused', leaseId: launch.lease.id, reason: 'batch_not_person' })
    assert.deepEqual(await bindingsOf(world, mixed.id), [])

    const alsoMine = await postMessage(world, { rootMessageId: launch.message.id })
    const clean = await createRun(world, { triggerMessageId: alsoMine.id })
    const outcome = await carryForwardExecutorBindings(world.prisma, {
      job: jobFor(world, { batchMessageIds: [mine.id, alsoMine.id], messageId: alsoMine.id, runId: clean.id }),
      runId: clean.id,
    })
    assert.equal(outcome.kind, 'carried')
  })
})

dbTest('a relayed post, a workflow send and a trigger fire authored as the holder carry nothing', async () => {
  await withWorld(async (world) => {
    const launch = await launchLocalApps(world)
    // `send_message` from an agent acting for the holder, and a workflow step
    // posting as the person who started it: role user, the holder's user id,
    // but never typed into a composer.
    const relayed = await postMessage(world, {
      authorship: false, metadata: { delegatedByAgentId: world.agentId, delegatedFromRunId: launch.run.id },
      rootMessageId: launch.message.id,
    })
    const workflow = await postMessage(world, {
      authorship: false, metadata: { workflow: { runId: launch.run.id, stepRunId: launch.run.id } },
      rootMessageId: launch.message.id,
    })
    for (const message of [relayed, workflow]) {
      const run = await createRun(world, { triggerMessageId: message.id })
      assert.deepEqual(await carryForwardExecutorBindings(world.prisma, {
        job: jobFor(world, { messageId: message.id, runId: run.id }), runId: run.id,
      }), { kind: 'refused', leaseId: launch.lease.id, reason: 'trigger_not_person' })
    }
    // A trigger fire is background automation under its creator's authority:
    // not interactive, and its kickoff is a hidden system message.
    const kickoff = await postMessage(world, {
      authorship: false, role: 'system', rootMessageId: launch.message.id, userId: null,
    })
    const fired = await createRun(world, { triggerMessageId: kickoff.id })
    assert.deepEqual(await carryForwardExecutorBindings(world.prisma, {
      job: jobFor(world, { interactive: false, messageId: kickoff.id, runId: fired.id }), runId: fired.id,
    }), { kind: 'refused', leaseId: launch.lease.id, reason: 'not_interactive' })
    // Even an interactive job cannot pass a message nobody typed.
    assert.deepEqual(await carryForwardExecutorBindings(world.prisma, {
      job: jobFor(world, { messageId: kickoff.id, runId: fired.id }), runId: fired.id,
    }), { kind: 'refused', leaseId: launch.lease.id, reason: 'trigger_not_person' })
    assert.equal(await world.prisma.executorBinding.count({ where: { leaseId: launch.lease.id } }), 2,
      'only the launch’s own two bindings exist')
  })
})

dbTest('a re-driven job is a no-op, not a conflict and not a second binding', async () => {
  await withWorld(async (world) => {
    const launch = await launchLocalApps(world)
    const reply = await postMessage(world, { rootMessageId: launch.message.id })
    const run = await createRun(world, { triggerMessageId: reply.id })
    const job = jobFor(world, { messageId: reply.id, runId: run.id })
    const first = await carryForwardExecutorBindings(world.prisma, { job, runId: run.id })
    assert.equal(first.kind, 'carried')
    const again = await carryForwardExecutorBindings(world.prisma, { job, runId: run.id })
    assert.equal(again.kind, 'already_bound')
    assert.equal(again.kind === 'already_bound' && again.lease?.id, launch.lease.id)
    assert.equal(await world.prisma.executorBinding.count({ where: { runId: run.id } }), 2)
    assert.equal((await auditRows(world, 'executor.run.carried')).length, 1)
    // The launch run itself is already bound, too.
    const launchRun = await carryForwardExecutorBindings(world.prisma, {
      job: jobFor(world, { messageId: launch.message.id, runId: launch.run.id }), runId: launch.run.id,
    })
    assert.equal(launchRun.kind, 'already_bound')
  })
})

dbTest('an agent no longer in the room, or a machine that went offline, refuses without throwing', async () => {
  await withWorld(async (world) => {
    const launch = await launchLocalApps(world)
    const reply = await postMessage(world, { rootMessageId: launch.message.id })
    const offline = await createRun(world, { triggerMessageId: reply.id })
    await world.prisma.executor.update({ where: { id: world.executorId }, data: { status: 'offline' } })
    assert.deepEqual(await carryForwardExecutorBindings(world.prisma, {
      job: jobFor(world, { messageId: reply.id, runId: offline.id }), runId: offline.id,
    }), { kind: 'refused', leaseId: launch.lease.id, reason: 'executor_unavailable' })
    assert.equal((await leaseRow(world, launch.lease.id)).endedAt, null, 'offline is a refusal, not an end')

    await world.prisma.executor.update({ where: { id: world.executorId }, data: { status: 'online', lastSeenAt: new Date() } })
    await world.prisma.agentBinding.deleteMany({ where: { agentId: world.agentId, channelId: world.channelId } })
    const unbound = await createRun(world, { triggerMessageId: reply.id })
    assert.deepEqual(await carryForwardExecutorBindings(world.prisma, {
      job: jobFor(world, { messageId: reply.id, runId: unbound.id }), runId: unbound.id,
    }), { kind: 'refused', leaseId: launch.lease.id, reason: 'executor_unavailable' })
  })
})
