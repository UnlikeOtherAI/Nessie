import assert from 'node:assert/strict'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'

import {
  confirmExecutorAccessChange,
  expireExecutorConversationLeases,
  prepareExecutorAccessChange,
  publishExecutorLeaseChanges,
  type ExecutorAccessChange,
} from '../src/index.js'
import { launchLocalApps, localAppsDescriptor, seedLeaseWorld, type LeaseWorld } from './lease-fixture.js'

/**
 * What a lease's holder is told, and when (conversation-lease.md §4): every
 * path that ends a lease reports exactly the leases it ended, so the caller
 * can address one change notice per holder once it has committed — and the
 * notice itself names ids on the holder's own user scope and nothing else.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

const withWorld = async (run: (world: LeaseWorld) => Promise<void>): Promise<void> => {
  const prisma = new PrismaClient()
  const world = await seedLeaseWorld(prisma)
  try {
    await run(world)
  } finally {
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
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

const refFor = (world: LeaseWorld, id: string) => ({
  actorUserId: world.holderId, id, organizationId: world.organizationId, threadId: world.threadId,
})

dbTest('an access change reports exactly the leases it ended, and none when it ends none', async () => {
  await withWorld(async (world) => {
    const launch = await launchLocalApps(world)
    const keeps = localAppsDescriptor(2)
    await world.prisma.executorCapabilityRevision.create({ data: {
      executorId: world.executorId, revision: 2, descriptor: keeps, signature: 'keeps-pair',
      localPolicyDigest: keeps.localPolicyDigest,
    } })
    const kept = await confirm(world, { kind: 'descriptor_review', revision: 2, status: 'active' })
    assert.deepEqual(kept.endedLeases, [], 'a review that keeps the pair ends nothing')

    const denied = await confirm(world, { kind: 'agent_executor_grant', agentId: world.agentId, state: 'denied' })
    assert.deepEqual(denied.endedLeases, [refFor(world, launch.lease.id)])
  })
  await withWorld(async (world) => {
    const launch = await launchLocalApps(world)
    const paused = await confirm(world, { kind: 'lifecycle', action: 'pause' })
    assert.deepEqual(paused.endedLeases, [refFor(world, launch.lease.id)])
  })
})

dbTest('the expiry sweep returns the leases it ended for their holders', async () => {
  await withWorld(async (world) => {
    const launch = await launchLocalApps(world)
    await world.prisma.executorConversationLease.update({
      where: { id: launch.lease.id }, data: { idleExpiresAt: new Date(Date.now() - 1_000) },
    })
    const ended = await expireExecutorConversationLeases(world.prisma)
    assert.deepEqual(ended.filter((lease) => lease.organizationId === world.organizationId), [
      refFor(world, launch.lease.id),
    ])
    assert.deepEqual(
      (await expireExecutorConversationLeases(world.prisma)).filter((lease) => lease.id === launch.lease.id),
      [],
      'a lease is reported once, by the pass that ended it',
    )
  })
})

test('a change notice goes to the holder’s own user scope, one per lease, ids only', async () => {
  const published: { data: unknown; event: string; scopes: unknown[] }[] = []
  const transport = {
    publishWs: async (scopes: unknown[], input: { data: unknown; event: string }) => {
      published.push({ data: input.data, event: input.event, scopes })
      return { data: input.data, event: input.event, ts: new Date().toISOString(), type: 'event' as const }
    },
  }
  const lease = {
    actorUserId: '11111111-1111-4111-8111-111111111111',
    id: '99999999-9999-4999-8999-999999999991',
    organizationId: '22222222-2222-4222-8222-222222222222',
    threadId: '66666666-6666-4666-8666-666666666666',
  }
  await publishExecutorLeaseChanges(transport as never, [])
  assert.deepEqual(published, [])
  await publishExecutorLeaseChanges(transport as never, [lease, { ...lease, id: '99999999-9999-4999-8999-999999999992' }])
  assert.deepEqual(published.map((entry) => entry.event), ['executor.lease.changed', 'executor.lease.changed'])
  assert.deepEqual(published[0], {
    data: { leaseId: lease.id, threadId: lease.threadId },
    event: 'executor.lease.changed',
    scopes: [{ kind: 'user', organizationId: lease.organizationId, userId: lease.actorUserId }],
  })
})
