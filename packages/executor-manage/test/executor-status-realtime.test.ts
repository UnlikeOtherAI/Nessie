import { WsEventSchema } from '@nessie/schemas'
import assert from 'node:assert/strict'
import test from 'node:test'
import { canReadExecutorStatus, expireStaleExecutorHeartbeats, publishExecutorStatus } from '../src/index.js'
import { leaseTestPrisma, seedLeaseWorld } from './lease-fixture.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('presence follows private assignments, live membership and organization boundaries', async () => {
  const prisma = leaseTestPrisma()
  const world = await seedLeaseWorld(prisma, { scope: 'private' })
  try {
    const input = { executorId: world.executorId, organizationId: world.organizationId }
    const read = (userId: string) => canReadExecutorStatus(prisma, { ...input, userId })
    assert.equal(await read(world.holderId), true)
    assert.equal(await read(world.memberId), false)
    await prisma.executorPrivateAssignment.deleteMany({
      where: { executorId: world.executorId, userId: world.adminId },
    })
    assert.equal(await read(world.adminId), false, 'org ownership cannot reveal a private executor')
    await prisma.organizationMember.update({
      where: { organizationId_userId: { organizationId: world.organizationId, userId: world.holderId } },
      data: { deactivatedAt: new Date() },
    })
    assert.equal(await read(world.holderId), false, 'a retained assignment cannot bypass deactivation')
    assert.equal(await canReadExecutorStatus(prisma, {
      ...input, organizationId: '22222222-2222-4222-8222-222222222222', userId: world.holderId,
    }), false)
    const now = new Date()
    await prisma.executor.update({ where: { id: world.executorId }, data: {
      lastSeenAt: new Date(now.getTime() - 61_000), status: 'online',
    } })
    assert.equal(await expireStaleExecutorHeartbeats(prisma, { executorId: world.executorId }, now), 1)
    let published = false
    await publishExecutorStatus(prisma, {
      publishWs: async (scopes, event) => {
        published = true
        assert.deepEqual(scopes, [{ kind: 'executor_inventory', organizationId: world.organizationId }])
        const parsed = WsEventSchema.parse({ ...event, type: 'event', ts: now.toISOString() })
        if (parsed.event !== 'executor.status.changed') throw new Error('wrong status event')
        assert.equal(parsed.data.status, 'offline')
        assert.equal(parsed.data.executorId, world.executorId)
        assert.equal('label' in parsed.data, false)
        return parsed
      },
    }, world.executorId)
    assert.equal(published, true)
  } finally {
    await world.cleanup()
    await prisma.$disconnect()
  }
})
