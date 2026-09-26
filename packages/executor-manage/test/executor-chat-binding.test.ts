import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { bindChatExecutors } from '../src/index.js'
import {
  createRun, jobFor, leaseTestPrisma, localAppsDescriptor, postMessage, seedLeaseWorld,
  type LeaseWorld,
} from './lease-fixture.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip
const withWorld = async (action: (world: LeaseWorld, machines: string[]) => Promise<void>) => {
  const prisma = leaseTestPrisma()
  const world = await seedLeaseWorld(prisma, { scope: 'private', pairingOwner: 'holder' })
  const machines = [world.executorId]
  try {
    await prisma.channel.update({ where: { id: world.channelId }, data: { type: 'dm' } })
    await prisma.channelMember.create({ data: { channelId: world.channelId, userId: world.holderId } })
    for (const label of ['Mac', 'Linux']) {
      const id = randomUUID()
      const descriptor = localAppsDescriptor(1)
      await prisma.executor.create({ data: {
        id, organizationId: world.organizationId, pairingOwnerUserId: world.holderId,
        label, scopeKind: 'private', status: 'online', lastSeenAt: new Date(),
        authorizationRevision: 1, profiles: ['workspace_sandbox'],
        privateAssignments: { create: [
          { principalKind: 'user', userId: world.holderId, role: 'admin' },
          { principalKind: 'agent', agentId: world.agentId, role: 'use' },
        ] },
        capabilityRevisions: { create: {
          revision: 1, descriptor, signature: 'test', localPolicyDigest: descriptor.localPolicyDigest,
          reviewStatus: 'active', reviewedByUserId: world.holderId,
        } },
        operationGrants: { create: ['mcp.tools', 'mcp.call'].map((operationKey) => ({
          agentId: world.agentId, operationKey, state: 'allowed', updatedByUserId: world.holderId,
          authorizationRevision: 1,
        })) },
      } })
      machines.push(id)
    }
    await action(world, machines)
  } finally {
    await prisma.run.deleteMany({ where: { threadId: world.threadId } })
    await prisma.executor.deleteMany({ where: { id: { in: machines.slice(1) } } })
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
}

dbTest('ordinary private chat and its next message reach all three assigned machines without a lease', async () => {
  await withWorld(async (world, machines) => {
    for (const content of ['ukaz mi disky pls', 'now check free space again']) {
      const message = await postMessage(world, {})
      await world.prisma.message.update({ where: { id: message.id }, data: { content } })
      const run = await createRun(world, { triggerMessageId: message.id })
      const input = { runId: run.id, job: jobFor(world, { messageId: message.id, runId: run.id }) }
      assert.equal(await bindChatExecutors(world.prisma, input), true)
      const bindings = await world.prisma.executorBinding.findMany({ where: { runId: run.id } })
      assert.equal(bindings.length, 6)
      assert.deepEqual(new Set(bindings.map((binding) => binding.executorId)), new Set(machines))
      assert.ok(bindings.every((binding) => binding.leaseId === null))
      assert.equal(await bindChatExecutors(world.prisma, input), false, 'redelivery preserves existing bindings')
    }
  })
})

dbTest('chat uses current assignment and machine availability', async () => {
  await withWorld(async (world, machines) => {
    await world.prisma.executorAgentOperationGrant.updateMany({
      where: { executorId: machines[1], agentId: world.agentId }, data: { state: 'denied' },
    })
    await world.prisma.executor.update({ where: { id: machines[2] }, data: { status: 'offline' } })
    const message = await postMessage(world, {})
    const run = await createRun(world, { triggerMessageId: message.id })
    assert.equal(await bindChatExecutors(world.prisma, {
      runId: run.id, job: jobFor(world, { messageId: message.id, runId: run.id }),
    }), true)
    const bindings = await world.prisma.executorBinding.findMany({ where: { runId: run.id } })
    assert.deepEqual(new Set(bindings.map((binding) => binding.executorId)), new Set([machines[0]]))
  })
})

dbTest('unattended work, shared rooms and non-person messages do not gain chat machine access', async () => {
  await withWorld(async (world) => {
    const message = await postMessage(world, {})
    const run = await createRun(world, { triggerMessageId: message.id })
    const input = { runId: run.id, job: jobFor(world, { messageId: message.id, runId: run.id }) }
    assert.equal(await bindChatExecutors(world.prisma, {
      ...input, job: { ...input.job, interactive: false },
    }), false)
    await world.prisma.channel.update({ where: { id: world.channelId }, data: { type: 'standard' } })
    assert.equal(await bindChatExecutors(world.prisma, input), false)
    await world.prisma.channel.update({ where: { id: world.channelId }, data: { type: 'dm' } })
    await world.prisma.channelMember.create({ data: { channelId: world.channelId, userId: world.memberId } })
    assert.equal(await bindChatExecutors(world.prisma, input), false, 'another human makes this a shared room')
    await world.prisma.channelMember.deleteMany({
      where: { channelId: world.channelId, userId: world.memberId },
    })
    await world.prisma.message.update({ where: { id: message.id }, data: { metadata: {} } })
    assert.equal(await bindChatExecutors(world.prisma, input), false)
    assert.equal(await world.prisma.executorBinding.count({ where: { runId: run.id } }), 0)
  })
})
