import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Prisma, PrismaClient } from '@prisma/client'

import {
  assertExecutorCommandBindingCurrent,
  carryForwardExecutorBindings,
  confirmExecutorAccessChange,
  createExecutorCommand,
  endExecutorConversationLease,
  expireExecutorConversationLeases,
  prepareExecutorAccessChange,
  transitionExecutorLifecycle,
  type ExecutorAccessChange,
} from '../src/index.js'
import {
  auditRows,
  createRun,
  jobFor,
  launchLocalApps,
  leaseRow,
  localAppsDescriptor,
  postMessage,
  seedLeaseWorld,
  type LeaseWorld,
} from './lease-fixture.js'

/**
 * Every way a conversation lease ends — End, the fencing transitions, both
 * expiries — against a real database, and the dispatch fence on a binding
 * that was already carried before the lease ended
 * (docs/plans/2026-09-22-executor-local-apps/conversation-lease.md §3 and §8).
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip
const secret = 'lease-test-command-secret'

const withWorld = async (run: (world: LeaseWorld) => Promise<void>): Promise<void> => {
  const prisma = new PrismaClient()
  const world = await seedLeaseWorld(prisma)
  try {
    await run(world)
  } finally {
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
}

/** Launch, then carry one reply, returning a binding that was carried. */
const carriedWorld = async (world: LeaseWorld) => {
  const launch = await launchLocalApps(world)
  const reply = await postMessage(world, { rootMessageId: launch.message.id })
  const run = await createRun(world, { triggerMessageId: reply.id })
  const outcome = await carryForwardExecutorBindings(world.prisma, {
    job: jobFor(world, { messageId: reply.id, runId: run.id }), runId: run.id,
  })
  assert.equal(outcome.kind, 'carried')
  const binding = await world.prisma.executorBinding.findFirstOrThrow({
    where: { runId: run.id, operationKey: 'mcp.call' }, select: { id: true },
  })
  // A control: before anything ends, that binding dispatches.
  await world.prisma.$transaction((tx) => assertExecutorCommandBindingCurrent(tx, binding.id))
  return { binding, launch, reply }
}

const assertFenced = async (world: LeaseWorld, bindingId: string) => {
  await assert.rejects(
    world.prisma.$transaction((tx) => assertExecutorCommandBindingCurrent(tx, bindingId)),
    (error: unknown) => (error as { code?: string }).code === 'EXECUTOR_BINDING_FENCED',
  )
}

/** The holder tries again after the end: refused, and nothing new is bound. */
const assertNextCarryRefused = async (world: LeaseWorld, leaseId: string, rootMessageId: string) => {
  const next = await postMessage(world, { rootMessageId })
  const run = await createRun(world, { triggerMessageId: next.id })
  assert.deepEqual(await carryForwardExecutorBindings(world.prisma, {
    job: jobFor(world, { messageId: next.id, runId: run.id }), runId: run.id,
  }), { kind: 'refused', leaseId, reason: 'lease_ended' })
  assert.equal(await world.prisma.executorBinding.count({ where: { runId: run.id } }), 0)
}

const confirm = async (world: LeaseWorld, change: ExecutorAccessChange) => {
  const prepared = await prepareExecutorAccessChange(world.prisma, world.adminContext, {
    executorId: world.executorId, change,
  })
  return confirmExecutorAccessChange(world.prisma, world.adminContext, {
    accessChangeId: prepared.accessChangeId, confirmationToken: prepared.confirmationToken,
    freshVerificationSatisfied: true,
  })
}

const assertEnded = async (
  world: LeaseWorld,
  leaseId: string,
  expected: { endedByUserId: string | null; reason: string },
) => {
  const lease = await leaseRow(world, leaseId)
  assert.ok(lease.endedAt, 'the lease is ended')
  assert.equal(lease.endedReason, expected.reason)
  assert.equal(lease.endedByUserId, expected.endedByUserId)
  const ended = (await auditRows(world, 'executor.lease.ended'))
    .filter((row) => row.resourceId === leaseId)
  assert.equal(ended.length, 1, 'exactly one end is audited')
  assert.equal((ended[0]!.metadata as Record<string, unknown>).reason, expected.reason)
}

dbTest('the launch audits the lease it creates, beside the binding it made', async () => {
  await withWorld(async (world) => {
    const launch = await launchLocalApps(world)
    const [created] = await auditRows(world, 'executor.lease.created')
    assert.ok(created)
    assert.equal(created.actorId, world.holderId)
    assert.equal(created.resourceId, launch.lease.id)
    const metadata = created.metadata as Record<string, unknown>
    assert.equal(metadata.launchRunId, launch.run.id)
    assert.equal(metadata.rootMessageId, launch.message.id)
    assert.deepEqual(new Set(metadata.bindingIds as string[]), new Set(launch.bindings.map((b) => b.bindingId)))
    const lease = await leaseRow(world, launch.lease.id)
    assert.deepEqual(lease.operationKeys, ['mcp.tools', 'mcp.call'])
    assert.equal(lease.idleExpiresAt.getTime() - lease.lastUsedAt.getTime(), 2 * 60 * 60 * 1_000)
    assert.equal(lease.absoluteExpiresAt.getTime() - lease.createdAt.getTime(), 12 * 60 * 60 * 1_000)
  })
})

dbTest('End pressed by the holder ends it; an executor admin may too; another member may not', async () => {
  await withWorld(async (world) => {
    const { binding, launch } = await carriedWorld(world)
    await assert.rejects(
      endExecutorConversationLease(world.prisma, world.memberContext, { leaseId: launch.lease.id }),
      (error: unknown) => (error as { code?: string }).code === 'EXECUTOR_NOT_FOUND',
      'another member learns nothing, not even that the lease exists',
    )
    assert.equal((await leaseRow(world, launch.lease.id)).endedAt, null)
    assert.deepEqual(
      await endExecutorConversationLease(world.prisma, world.holderContext, { leaseId: launch.lease.id }),
      {
        ended: true,
        lease: {
          actorUserId: world.holderId, id: launch.lease.id, organizationId: world.organizationId,
          threadId: world.threadId,
        },
      },
    )
    await assertEnded(world, launch.lease.id, { endedByUserId: world.holderId, reason: 'person' })
    await assertFenced(world, binding.id)
    await assertNextCarryRefused(world, launch.lease.id, launch.message.id)
  })
  await withWorld(async (world) => {
    const { launch } = await carriedWorld(world)
    await endExecutorConversationLease(world.prisma, world.adminContext, { leaseId: launch.lease.id })
    await assertEnded(world, launch.lease.id, { endedByUserId: world.adminId, reason: 'person' })
  })
})

dbTest('revoking the agent’s access ends its leases in the same transaction', async () => {
  await withWorld(async (world) => {
    const { binding, launch } = await carriedWorld(world)
    await confirm(world, { kind: 'agent_executor_grant', agentId: world.agentId, state: 'denied' })
    await assertEnded(world, launch.lease.id, { endedByUserId: world.adminId, reason: 'access_revoked' })
    await assertFenced(world, binding.id)
    await assertNextCarryRefused(world, launch.lease.id, launch.message.id)
  })
  await withWorld(async (world) => {
    // Narrowing: one operation of the pair denied is enough.
    const { launch } = await carriedWorld(world)
    await confirm(world, { kind: 'agent_operation_grant', agentId: world.agentId, operationKey: 'mcp.call', state: 'denied' })
    await assertEnded(world, launch.lease.id, { endedByUserId: world.adminId, reason: 'access_revoked' })
  })
})

dbTest('pausing or revoking the executor ends every lease on it', async () => {
  await withWorld(async (world) => {
    const { binding, launch } = await carriedWorld(world)
    await transitionExecutorLifecycle(world.prisma, world.adminContext, { executorId: world.executorId, action: 'pause' })
    await assertEnded(world, launch.lease.id, { endedByUserId: world.adminId, reason: 'executor_paused' })
    await assertFenced(world, binding.id)
  })
  await withWorld(async (world) => {
    const { launch } = await carriedWorld(world)
    await transitionExecutorLifecycle(world.prisma, world.adminContext, { executorId: world.executorId, action: 'revoke' })
    await assertEnded(world, launch.lease.id, { endedByUserId: world.adminId, reason: 'executor_revoked' })
  })
})

dbTest('a descriptor review that drops mcp.* ends the lease; one that keeps it does not', async () => {
  await withWorld(async (world) => {
    const { launch } = await carriedWorld(world)
    const keeps = localAppsDescriptor(2)
    await world.prisma.executorCapabilityRevision.create({ data: {
      executorId: world.executorId, revision: 2, descriptor: keeps, signature: 'keeps-pair',
      localPolicyDigest: keeps.localPolicyDigest,
    } })
    await confirm(world, { kind: 'descriptor_review', revision: 2, status: 'active' })
    assert.equal((await leaseRow(world, launch.lease.id)).endedAt, null, 'the pair survives this review')

    const narrowed = localAppsDescriptor(3, ['file.read'])
    await world.prisma.executorCapabilityRevision.create({ data: {
      executorId: world.executorId, revision: 3, descriptor: narrowed, signature: 'drops-pair',
      localPolicyDigest: narrowed.localPolicyDigest,
    } })
    await confirm(world, { kind: 'descriptor_review', revision: 3, status: 'active' })
    await assertEnded(world, launch.lease.id, { endedByUserId: world.adminId, reason: 'descriptor_narrowed' })
    await assertNextCarryRefused(world, launch.lease.id, launch.message.id)
  })
})

dbTest('past its idle or its absolute window, a lease stops carrying and a carried binding is fenced', async () => {
  for (const window of ['idleExpiresAt', 'absoluteExpiresAt'] as const) {
    await withWorld(async (world) => {
      const { binding, launch } = await carriedWorld(world)
      const past = new Date(Date.now() - 1_000)
      await world.prisma.executorConversationLease.update({
        where: { id: launch.lease.id },
        data: window === 'idleExpiresAt' ? { idleExpiresAt: past } : { absoluteExpiresAt: past },
      })
      // Nothing ended it yet: the authorization revision is untouched, so this
      // fence is the lease's alone.
      assert.equal((await leaseRow(world, launch.lease.id)).endedAt, null)
      await assertFenced(world, binding.id)
      await assertNextCarryRefused(world, launch.lease.id, launch.message.id)
      await assertEnded(world, launch.lease.id, { endedByUserId: null, reason: 'expired' })
      const [ended] = (await auditRows(world, 'executor.lease.ended')).filter((row) => row.resourceId === launch.lease.id)
      assert.equal(ended?.actorType, 'system')
    })
  }
})

dbTest('the maintenance sweep records an expiry nobody tried to use', async () => {
  await withWorld(async (world) => {
    const launch = await launchLocalApps(world)
    await world.prisma.executorConversationLease.update({
      where: { id: launch.lease.id }, data: { idleExpiresAt: new Date(Date.now() - 1_000) },
    })
    await expireExecutorConversationLeases(world.prisma)
    await assertEnded(world, launch.lease.id, { endedByUserId: null, reason: 'expired' })
  })
})

dbTest('every executor command dispatched under a live lease moves its idle window', async () => {
  await withWorld(async (world) => {
    const { binding, launch } = await carriedWorld(world)
    const stale = new Date(Date.now() - 60 * 60 * 1_000)
    await world.prisma.executorConversationLease.update({
      where: { id: launch.lease.id },
      data: { lastUsedAt: stale, idleExpiresAt: new Date(stale.getTime() + 2 * 60 * 60 * 1_000) },
    })
    const bound = await world.prisma.executorBinding.findUniqueOrThrow({
      where: { id: binding.id }, select: { runId: true },
    })
    const toolCall = await world.prisma.toolCall.create({ data: {
      agentId: world.agentId, executorBindingId: binding.id, inputSummary: 'server=kelpie',
      runId: bound.runId, startedAt: new Date(), toolName: 'executor_mcp_call',
    } })
    const queueJob = await world.prisma.queueJob.create({ data: {
      idempotencyKey: `lease-test:${world.executorId}:${randomUUID()}`, payload: {}, status: 'processing',
      topic: 'executor.command',
    } })
    await world.prisma.$transaction((tx) => createExecutorCommand(tx, {
      bindingId: binding.id, commandId: randomUUID(), encryptionSecret: secret,
      expiresAt: new Date(Date.now() + 60_000), payload: { args: {}, runId: bound.runId },
      queueJobId: queueJob.id, toolCallId: toolCall.id,
    }))
    const lease = await leaseRow(world, launch.lease.id)
    assert.ok(lease.lastUsedAt > stale)
    assert.equal(lease.idleExpiresAt.getTime() - lease.lastUsedAt.getTime(), 2 * 60 * 60 * 1_000)
  })
})

dbTest('relaunching in the same conversation with the agent replaces the earlier lease', async () => {
  const prisma = new PrismaClient()
  const world = await seedLeaseWorld(prisma, { agentConversation: true })
  try {
    const first = await launchLocalApps(world)
    const second = await launchLocalApps(world)
    await assertEnded(world, first.lease.id, { endedByUserId: world.holderId, reason: 'replaced' })
    assert.equal((await leaseRow(world, second.lease.id)).endedAt, null)
  } finally {
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
})

dbTest('the table refuses a second live lease, another bundle, or an unknown end reason', async () => {
  await withWorld(async (world) => {
    const launch = await launchLocalApps(world)
    const row = await leaseRow(world, launch.lease.id)
    const copy = {
      absoluteExpiresAt: row.absoluteExpiresAt, actorUserId: row.actorUserId, agentId: row.agentId,
      executorId: row.executorId, idleExpiresAt: row.idleExpiresAt, lastUsedAt: row.lastUsedAt,
      launchRunId: row.launchRunId, operationKeys: row.operationKeys, organizationId: row.organizationId,
      rootMessageId: row.rootMessageId, threadId: row.threadId,
    }
    await assert.rejects(world.prisma.executorConversationLease.create({ data: copy }),
      (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002',
      'one live lease per (thread, root message, agent, person)')
    const ended = { ...copy, endedAt: new Date(), endedReason: 'person' }
    await world.prisma.executorConversationLease.create({ data: ended })
    for (const data of [
      { ...ended, operationKeys: ['mcp.tools'] },
      { ...ended, operationKeys: ['mcp.tools', 'mcp.call', 'command.run'] },
      { ...ended, endedReason: 'bored' },
      { ...ended, endedReason: null },
    ]) {
      await assert.rejects(world.prisma.executorConversationLease.create({ data }), /23514|check constraint/i)
    }
  })
})
