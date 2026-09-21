import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'
import {
  ExecutorPairingClaimRequestSchema, ExecutorPairingStartRequestSchema,
  type ExecutorPairingDecisionRequest,
} from '@nessie/schemas'
import {
  claimExecutorCodePairing, decideExecutorCodePairing, pollExecutorCodePairing,
  previewExecutorCodePairing, startExecutorCodePairing,
  expireExecutorCodePairings,
  type PairingAudit, type PairingClaimAuthority, type PairingNames,
} from '../src/index.js'
import { canonicalExecutorPayload } from '../src/executor-canonical-json.js'
import { pairingCode, pairingCodeVerifier, pairingStartPayload } from '../src/executor-code-proof.js'

const signature = (key: KeyObject, domain: string, payload: unknown) =>
  sign(null, Buffer.from(canonicalExecutorPayload(domain, payload)), key).toString('base64url')
const machine = (now = new Date(), replacesExecutorId?: string, previousKey?: KeyObject) => {
  const keys = generateKeyPairSync('ed25519')
  const descriptor = {
    protocolVersion: 1, revision: 1, profiles: ['workspace_sandbox'],
    platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
    supervisor: 'service', sandboxBackend: 'none', operationKeys: ['file.list'],
    localPolicyDigest: `sha256:${'1'.repeat(64)}`,
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 1 },
  }
  const payload = {
    requestId: randomUUID(), timestamp: now.toISOString(), machineName: 'Pairing test machine',
    machinePublicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    descriptor: { descriptor, signature: signature(keys.privateKey, 'nessie.executor.descriptor.v1', descriptor) },
    ...(replacesExecutorId ? { replacesExecutorId } : {}),
  }
  return { key: keys.privateKey, input: ExecutorPairingStartRequestSchema.parse({
    ...payload, signature: signature(keys.privateKey, 'nessie.executor.pairing.start.v1', payload),
    ...(previousKey ? { replacementSignature: signature(previousKey, 'nessie.executor.pairing.replace.v1', payload) } : {}),
  }) }
}

test('pairing codes are exactly eight decimal digits and keyed; leading zeroes survive', () => {
  let leadingZero = false
  for (let i = 0; i < 100; i += 1) {
    const code = pairingCode('test secret', String(i))
    assert.match(code, /^[0-9]{8}$/)
    leadingZero ||= code.startsWith('0')
    assert.notEqual(pairingCode('other secret', String(i)), code)
    assert.notEqual(pairingCodeVerifier('test secret', code), code)
  }
  assert.equal(leadingZero, true)
})

const dbTest = process.env.DATABASE_URL ? test : test.skip
dbTest('codes bind one machine, claim once, and require exact local consent before connecting', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  const pairingIds: string[] = []
  const secret = randomUUID()
  const events: string[] = []
  const audit: PairingAudit = async (_tx, event) => { events.push(event.action) }
  const authority: PairingClaimAuthority = {
    userId, projectIds: [], options: {
      organization: { id: organizationId, name: 'Test organisation' }, teams: [], scopes: ['private'],
    },
  }
  const names: PairingNames = async () => ({ organization: authority.options.organization, team: null })
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'Pairing security test' } })
    await prisma.user.create({ data: { id: userId, displayName: 'Pairing tester', email: `${userId}@example.test` } })
    await prisma.organizationMember.create({ data: { organizationId, userId, role: 'owner' } })
    const first = machine()
    pairingIds.push(first.input.requestId)
    await assert.rejects(startExecutorCodePairing(prisma, secret, {
      ...first.input, machineName: 'Substituted machine',
    }, audit), /proof is invalid/)
    const started = await startExecutorCodePairing(prisma, secret, first.input, audit)
    assert.deepEqual(await startExecutorCodePairing(prisma, secret, first.input, audit), started)
    assert.equal(await prisma.executor.count({ where: { organizationId } }), 0)
    const preview = await previewExecutorCodePairing(prisma, secret, started.code)
    assert.equal(preview.fingerprint, started.fingerprint)
    const claimInput = ExecutorPairingClaimRequestSchema.parse({
      code: started.code, fingerprint: started.fingerprint, label: 'My workstation',
      scope: { kind: 'private', organizationId }, teamId: null,
    })
    await assert.rejects(claimExecutorCodePairing(prisma, secret, {
      ...claimInput, fingerprint: `sha256:${'f'.repeat(64)}`,
    }, authority, audit), /fingerprint/)
    const claims = await Promise.allSettled([
      claimExecutorCodePairing(prisma, secret, claimInput, authority, audit),
      claimExecutorCodePairing(prisma, secret, { ...claimInput, label: 'Other workstation' }, authority, audit),
    ])
    assert.equal(claims.filter((result) => result.status === 'fulfilled').length, 1,
      claims.flatMap((result) => result.status === 'rejected' ? [String(result.reason)] : []).join('\n'))
    assert.equal(await prisma.executor.count({ where: { organizationId } }), 1)
    const executor = await prisma.executor.findFirstOrThrow({ where: { organizationId } })
    const retriedClaim = await claimExecutorCodePairing(prisma, secret, {
      ...claimInput, label: executor.label,
    }, authority, audit)
    assert.equal(retriedClaim.executorId, executor.id)
    assert.equal(events.filter((event) => event === 'executor.pairing.claimed').length, 1)
    assert.equal(executor.status, 'pending_pairing')
    assert.equal(executor.machinePublicKey, null)
    assert.equal(await prisma.executorEnrollment.count({ where: { executorId: executor.id } }), 0)
    await assert.rejects(previewExecutorCodePairing(prisma, secret, started.code), /no longer available/)
    const pollPayload = { pairingId: started.pairingId, timestamp: new Date().toISOString() }
    const attacker = machine()
    await assert.rejects(pollExecutorCodePairing(prisma, {
      ...pollPayload, signature: signature(attacker.key, 'nessie.executor.pairing.poll.v1', pollPayload),
    }, names), /proof is invalid/)
    const pending = await pollExecutorCodePairing(prisma, {
      ...pollPayload, signature: signature(first.key, 'nessie.executor.pairing.poll.v1', pollPayload),
    }, names)
    assert.equal(pending.status, 'awaiting_confirmation')
    assert.equal(pending.claim?.organization.name, 'Test organisation')
    assert.ok(pending.claim)
    const decisionPayload = {
      ...pollPayload, executorId: executor.id, claimDigest: pending.claim.claimDigest,
    }
    const decision: ExecutorPairingDecisionRequest = {
      ...decisionPayload, signature: signature(first.key, 'nessie.executor.pairing.confirm.v1', decisionPayload),
    }
    await assert.rejects(decideExecutorCodePairing(prisma, {
      ...decision, claimDigest: `sha256:${'f'.repeat(64)}`,
    }, 'confirm', names, audit), /proof is invalid/)
    await assert.rejects(decideExecutorCodePairing(prisma, decision, 'confirm', async () => {
      throw new Error('Live membership revoked')
    }, audit), /membership revoked/)
    assert.equal((await prisma.executor.findUniqueOrThrow({ where: { id: executor.id } })).status, 'pending_pairing')
    const confirmed = await decideExecutorCodePairing(prisma, decision, 'confirm', names, audit)
    assert.equal(confirmed.status, 'confirmed')
    assert.deepEqual(await decideExecutorCodePairing(prisma, decision, 'confirm', names, audit), confirmed)
    const paired = await prisma.executor.findUniqueOrThrow({ where: { id: executor.id } })
    assert.equal(paired.status, 'offline')
    assert.equal(paired.machinePublicKey, first.input.machinePublicKey)
    assert.equal(events.filter((event) => event === 'executor.pairing.confirmed').length, 1)

    const replacement = machine(new Date(), executor.id, first.key)
    pairingIds.push(replacement.input.requestId)
    const badPayload = pairingStartPayload(replacement.input)
    await assert.rejects(startExecutorCodePairing(prisma, secret, {
      ...replacement.input,
      replacementSignature: signature(attacker.key, 'nessie.executor.pairing.replace.v1', badPayload),
    }, audit), /proof is invalid/)
    assert.equal((await prisma.executor.findUniqueOrThrow({ where: { id: executor.id } })).status, 'offline')
    const next = await startExecutorCodePairing(prisma, secret, replacement.input, audit)
    const retired = await prisma.executor.findUniqueOrThrow({ where: { id: executor.id } })
    assert.equal(retired.status, 'revoked')
    assert.equal(retired.activeConnectionEpoch, paired.activeConnectionEpoch + 1n)
    await startExecutorCodePairing(prisma, secret, replacement.input, audit)
    assert.equal(events.filter((event) => event === 'executor.pairing.replaced').length, 1)
    const cancelPayload = { pairingId: next.pairingId, timestamp: new Date().toISOString() }
    const cancelled = await decideExecutorCodePairing(prisma, {
      ...cancelPayload, signature: signature(replacement.key, 'nessie.executor.pairing.cancel.v1', cancelPayload),
    }, 'cancel', names, audit)
    assert.equal(cancelled.status, 'rejected')
    await assert.rejects(previewExecutorCodePairing(prisma, secret, next.code), /no longer available/)

    const past = new Date(Date.now() - 601_000)
    const expiredMachine = machine(past)
    pairingIds.push(expiredMachine.input.requestId)
    const expired = await startExecutorCodePairing(prisma, secret, expiredMachine.input, audit, past)
    await assert.rejects(previewExecutorCodePairing(prisma, secret, expired.code), /no longer available/)
    await assert.rejects(claimExecutorCodePairing(prisma, secret, {
      ...claimInput, code: expired.code, fingerprint: expired.fingerprint,
    }, authority, audit), /no longer available/)
    const expiredCancelPayload = { pairingId: expired.pairingId, timestamp: new Date().toISOString() }
    const expiredCancel = { ...expiredCancelPayload,
      signature: signature(expiredMachine.key, 'nessie.executor.pairing.cancel.v1', expiredCancelPayload),
    }
    assert.equal((await decideExecutorCodePairing(prisma, expiredCancel, 'cancel', names, audit)).status, 'rejected')
    assert.equal((await decideExecutorCodePairing(prisma, expiredCancel, 'cancel', names, audit)).status, 'rejected')

    // Force the first derivation to collide; mint must choose another code and
    // response-loss retry must recover that choice, not get stuck forever.
    const collision = machine()
    const occupyingId = randomUUID()
    pairingIds.push(collision.input.requestId, occupyingId)
    const occupiedCode = pairingCode(secret, collision.input.requestId)
    await prisma.executorPairingCode.create({ data: {
      id: occupyingId, codeVerifier: pairingCodeVerifier(secret, occupiedCode), requestDigest: 'test collision',
      machineName: 'Other machine', machinePublicKey: 'unclaimed', fingerprint: 'unclaimed',
      descriptor: {}, expiresAt: past,
    } })
    const resolvedCollision = await startExecutorCodePairing(prisma, secret, collision.input, audit)
    assert.notEqual(resolvedCollision.code, occupiedCode)
    assert.deepEqual(await startExecutorCodePairing(prisma, secret, collision.input, audit), resolvedCollision)
    const expiring = await claimExecutorCodePairing(prisma, secret, {
      ...claimInput, code: resolvedCollision.code, fingerprint: resolvedCollision.fingerprint,
    }, authority, audit)
    await prisma.executorPairingCode.update({ where: { id: expiring.pairingId }, data: { expiresAt: past } })
    await expireExecutorCodePairings(prisma, organizationId, audit)
    await expireExecutorCodePairings(prisma, organizationId, audit)
    assert.equal((await prisma.executor.findUniqueOrThrow({ where: { id: expiring.executorId } })).status, 'revoked')
    assert.equal(events.filter((event) => event === 'executor.pairing.expired').length, 1)
  } finally {
    await prisma.executorPairingCode.deleteMany({ where: { id: { in: pairingIds } } })
    await prisma.executor.deleteMany({ where: { organizationId } })
    await prisma.organizationMember.deleteMany({ where: { organizationId, userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.$disconnect()
  }
})
