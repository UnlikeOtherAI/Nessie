import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'

import { canonicalExecutorPayload, reportExecutorHeartbeat } from '../src/index.js'
import { leaseTestPrisma, seedLeaseWorld } from './lease-fixture.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('heartbeat reports existing private-owner authority without adding a session grant', async () => {
  for (const scope of ['private', 'project', 'organization'] as const) {
    const prisma = leaseTestPrisma()
    const world = await seedLeaseWorld(prisma, { codingSessions: true, pairingOwner: 'holder', scope })
    try {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519')
      const machinePublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
      const executor = await prisma.executor.update({
        where: { id: world.executorId }, data: { machinePublicKey }, select: { activeConnectionEpoch: true },
      })
      const payload = { connectionEpoch: executor.activeConnectionEpoch.toString(),
        executorId: world.executorId, observedAt: new Date().toISOString() }
      const signature = sign(null, Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.heartbeat.v1', payload)),
        privateKey).toString('base64url')
      const answer = await reportExecutorHeartbeat(prisma, { ...payload, signature })
      assert.equal(answer.existingSessionsAllowed, scope === 'private')
    } finally {
      try { await world.cleanup() } finally { await prisma.$disconnect() }
    }
  }
})
