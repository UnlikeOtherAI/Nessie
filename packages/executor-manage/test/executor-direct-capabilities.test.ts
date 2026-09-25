import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import { canonicalExecutorPayload, submitExecutorDescriptor, setExecutorAgentAccess } from '../src/index.js'
import { launchLocalApps, leaseTestPrisma, localAppsDescriptor, seedLeaseWorld } from './lease-fixture.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('signed capability changes activate immediately, fence commands and end narrowed leases', async () => {
  const prisma = leaseTestPrisma()
  const world = await seedLeaseWorld(prisma, { scope: 'private' })
  try {
    const { lease } = await launchLocalApps(world)
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const machine = await prisma.executor.update({ where: { id: world.executorId }, data: {
      machinePublicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    } })
    const descriptor = localAppsDescriptor(2, ['file.read'])
    const input = { executorId: world.executorId, connectionEpoch: machine.activeConnectionEpoch.toString(),
      descriptor: { descriptor, signature: sign(null,
        Buffer.from(canonicalExecutorPayload('nessie.executor.descriptor.v1', descriptor)), privateKey,
      ).toString('base64url') },
    }
    const result = await submitExecutorDescriptor(prisma, input)
    assert.equal(result.reviewStatus, 'active')
    assert.deepEqual(result.endedLeases?.map((entry) => entry.id), [lease.id])
    assert.equal((await prisma.executorConversationLease.findUniqueOrThrow({ where: { id: lease.id } })).endedReason,
      'descriptor_narrowed')
    const updated = await prisma.executor.findUniqueOrThrow({ where: { id: world.executorId } })
    assert.ok(updated.authorizationRevision > machine.authorizationRevision)
    assert.ok(updated.activeConnectionEpoch > machine.activeConnectionEpoch)
    await assert.rejects(submitExecutorDescriptor(prisma, input), /fenced/)
    assert.deepEqual(await submitExecutorDescriptor(prisma, { ...input,
      connectionEpoch: updated.activeConnectionEpoch.toString() }), { reviewStatus: 'active', revision: 2 })
  } finally { await world.cleanup(); await prisma.$disconnect() }
})

dbTest('direct agent removal ends existing use and policy failure rolls back assignment', async () => {
  const prisma = leaseTestPrisma()
  const world = await seedLeaseWorld(prisma, { scope: 'private' })
  try {
    const { lease } = await launchLocalApps(world)
    const input = { executorId: world.executorId, agentId: world.agentId, state: 'denied' as const }
    await assert.rejects(setExecutorAgentAccess(prisma, world.adminContext, input, async () => {
      throw new Error('Policy update refused')
    }), /Policy update refused/)
    assert.equal((await prisma.executorConversationLease.findUniqueOrThrow({ where: { id: lease.id } })).endedAt, null)
    const removed = await setExecutorAgentAccess(prisma, world.adminContext, input, async () => {})
    assert.deepEqual(removed.endedLeases.map((entry) => entry.id), [lease.id])
    assert.equal(await prisma.executorPrivateAssignment.count({ where: { executorId: world.executorId,
      agentId: world.agentId } }), 0)
    await assert.rejects(setExecutorAgentAccess(prisma, world.memberContext, {
      ...input, state: 'allowed',
    }, async () => {}))
    await setExecutorAgentAccess(prisma, world.adminContext, { ...input, state: 'allowed' }, async () => {})
    assert.equal(await prisma.executorPrivateAssignment.count({ where: { executorId: world.executorId,
      agentId: world.agentId } }), 1)
  } finally { await world.cleanup(); await prisma.$disconnect() }
})
