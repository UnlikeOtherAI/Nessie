import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'
import { ExecutorPairingStartRequestSchema } from '@nessie/schemas'

import {
  assertExecutorCommandBindingCurrent,
  carryForwardExecutorBindings,
  expireExecutorCodePairings,
  startExecutorCodePairing,
  type ExecutorLeaseRef,
  type PairingAudit,
} from '../src/index.js'
import { canonicalExecutorPayload } from '../src/executor-canonical-json.js'
import { pairingDigest } from '../src/executor-code-proof.js'
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
 * The pairing paths revoke an executor row with the same fence a management
 * revoke uses, so they end its conversation leases in the same transaction
 * (docs/executor-protocol/conversation-leases.md §3): a machine that pairs
 * again, and a pairing code that runs out. A lease left live on a revoked row
 * would keep the holder's composer promising reach for up to two hours.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip
const noAudit: PairingAudit = async () => {}

const signature = (key: KeyObject, domain: string, payload: unknown) =>
  sign(null, Buffer.from(canonicalExecutorPayload(domain, payload)), key).toString('base64url')

const rawPublicKey = (key: KeyObject): string =>
  key.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')

/** A new machine key asking to replace `replacesExecutorId`, signed by its old key. */
const replacementRequest = (replacesExecutorId: string, previousKey: KeyObject) => {
  const keys = generateKeyPairSync('ed25519')
  const descriptor = {
    protocolVersion: 1, revision: 1, profiles: ['workspace_sandbox'],
    platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
    supervisor: 'service', sandboxBackend: 'none', operationKeys: ['mcp.tools', 'mcp.call'],
    localPolicyDigest: `sha256:${'5'.repeat(64)}`,
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 1 },
  }
  const payload = {
    requestId: randomUUID(), timestamp: new Date().toISOString(), machineName: 'Minis',
    machinePublicKey: rawPublicKey(keys.publicKey),
    descriptor: { descriptor, signature: signature(keys.privateKey, 'nessie.executor.descriptor.v1', descriptor) },
    replacesExecutorId,
  }
  return ExecutorPairingStartRequestSchema.parse({
    ...payload,
    signature: signature(keys.privateKey, 'nessie.executor.pairing.start.v1', payload),
    replacementSignature: signature(previousKey, 'nessie.executor.pairing.replace.v1', payload),
  })
}

const withWorld = async (run: (world: LeaseWorld, pairingIds: string[]) => Promise<void>): Promise<void> => {
  const prisma = new PrismaClient()
  const world = await seedLeaseWorld(prisma)
  const pairingIds: string[] = []
  try {
    await run(world, pairingIds)
  } finally {
    try {
      await prisma.executorPairingCode.deleteMany({ where: { id: { in: pairingIds } } })
      await world.cleanup()
    } finally { await prisma.$disconnect() }
  }
}

/** Launch, carry one reply, and return the carried binding and the lease. */
const carried = async (world: LeaseWorld) => {
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
  return { binding, launch }
}

const assertRevokedByPairing = async (world: LeaseWorld, leaseId: string) => {
  const lease = await leaseRow(world, leaseId)
  assert.ok(lease.endedAt, 'the lease ended with the executor row')
  assert.equal(lease.endedReason, 'executor_revoked')
  assert.equal(lease.endedByUserId, null, 'no person ended it')
  const [ended, ...more] = (await auditRows(world, 'executor.lease.ended')).filter((row) => row.resourceId === leaseId)
  assert.equal(more.length, 0)
  assert.equal(ended?.actorType, 'system')
  assert.equal(ended?.actorId, 'executor-pairing')
}

dbTest('a machine that pairs again ends the leases on its previous executor, and tells their holders', async () => {
  await withWorld(async (world, pairingIds) => {
    const { binding, launch } = await carried(world)
    const previousKey = generateKeyPairSync('ed25519')
    const machinePublicKey = rawPublicKey(previousKey.publicKey)
    await world.prisma.executor.update({
      where: { id: world.executorId },
      data: { machineKeyFingerprint: pairingDigest(machinePublicKey), machinePublicKey },
    })
    const request = replacementRequest(world.executorId, previousKey.privateKey)
    pairingIds.push(request.requestId)
    const told: ExecutorLeaseRef[][] = []
    await startExecutorCodePairing(world.prisma, randomUUID(), request, noAudit, undefined, async (leases) => {
      told.push(leases)
    })
    assert.equal((await world.prisma.executor.findUniqueOrThrow({ where: { id: world.executorId } })).status, 'revoked')
    await assertRevokedByPairing(world, launch.lease.id)
    assert.deepEqual(told, [[{
      actorUserId: world.holderId, id: launch.lease.id, organizationId: world.organizationId, threadId: world.threadId,
    }]], 'the holder is told once the new pairing has committed')
    await assert.rejects(
      world.prisma.$transaction((tx) => assertExecutorCommandBindingCurrent(tx, binding.id)),
      (error: unknown) => (error as { code?: string }).code === 'EXECUTOR_BINDING_FENCED',
    )
    // A retry of the same request returns the old receipt and ends nothing more.
    await startExecutorCodePairing(world.prisma, randomUUID(), request, noAudit, undefined, async (leases) => {
      told.push(leases)
    })
    assert.equal(told.length, 1)
  })
})

dbTest('a pairing code that runs out revokes its executor row and whatever lease is on it', async () => {
  await withWorld(async (world, pairingIds) => {
    // Artificial on purpose: an unconfirmed pairing's executor never connects,
    // so no lease can reach it. The revoke still owns the invariant rather
    // than relying on that.
    const { launch } = await carried(world)
    await world.prisma.executor.update({ where: { id: world.executorId }, data: { status: 'pending_pairing' } })
    const pairingId = randomUUID()
    pairingIds.push(pairingId)
    await world.prisma.executorPairingCode.create({ data: {
      id: pairingId, codeVerifier: `lease-test-${pairingId}`, requestDigest: 'lease test', machineName: 'Minis',
      machinePublicKey: 'unclaimed', fingerprint: `lease-test-${pairingId}`, descriptor: {},
      executorId: world.executorId, expiresAt: new Date(Date.now() - 1_000),
    } })
    await expireExecutorCodePairings(world.prisma, world.organizationId, noAudit)
    assert.equal((await world.prisma.executor.findUniqueOrThrow({ where: { id: world.executorId } })).status, 'revoked')
    await assertRevokedByPairing(world, launch.lease.id)
  })
})
