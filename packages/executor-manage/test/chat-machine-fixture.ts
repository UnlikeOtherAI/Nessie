import { randomUUID } from 'node:crypto'
import { leaseTestPrisma, localAppsDescriptor, seedLeaseWorld, type LeaseWorld } from './lease-fixture.js'

export const withChatMachines = async (action: (world: LeaseWorld, machines: string[]) => Promise<void>) => {
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
