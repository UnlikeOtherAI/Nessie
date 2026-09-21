import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'
import { signLocalInferenceResourceAttachment } from '@nessie/local-inference-host'
import {
  attachLocalInferenceResource, controlLocalInferenceResource, setLocalInferenceResourceCapacity,
} from '../src/services/local-inference-resource.js'

const databaseTest = process.env.DATABASE_URL ? test : test.skip

databaseTest('two authenticated hosts share one resource and only its owner controls pause and capacity', async (t) => {
  const prisma = new PrismaClient()
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url')
  const organizationId = randomUUID()
  const otherOrganizationId = randomUUID()
  const custodianUserId = randomUUID()
  // Local-mode fixtures only; no UOA identity or membership is manufactured.
  await prisma.user.create({ data: {
    id: custodianUserId, email: `${custodianUserId}@resource-fixture.test`, displayName: 'Resource fixture',
  } })
  await prisma.organization.createMany({ data: [organizationId, otherOrganizationId].map((id) => ({ id, name: id })) })
  await prisma.organizationMember.createMany({ data: [organizationId, otherOrganizationId].map((id) => ({
    organizationId: id, userId: custodianUserId,
  })) })
  t.after(async () => {
    await prisma.localInferenceHost.deleteMany({ where: { organizationId: { in: [organizationId, otherOrganizationId] } } })
    await prisma.localInferenceResource.deleteMany({ where: { organizationId, publicKey } })
    await prisma.organization.deleteMany({ where: { id: { in: [organizationId, otherOrganizationId] } } })
    await prisma.user.delete({ where: { id: custodianUserId } })
    await prisma.$disconnect()
  })
  const hosts = await Promise.all([0, 1, 2].map((index) => {
    const machine = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    return prisma.localInferenceHost.create({
      data: {
        organizationId: index === 2 ? otherOrganizationId : organizationId, custodianUserId,
        displayLabel: 'resource test', transport: 'desktop', publicKey: machine,
        publicKeyFingerprint: createHash('sha256').update(machine).digest('hex'),
      },
    })
  }))
  const attach = (host: typeof hosts[number], revision = 0, paused = false) => {
    const attachment = {
      connectionEpoch: String(host.connectionEpoch), hostId: host.id, organizationId: host.organizationId, publicKey,
    }
    return prisma.$transaction((tx) => attachLocalInferenceResource(tx, {
      attachment: { ...attachment, signature: signLocalInferenceResourceAttachment(attachment, privateKey) },
      host, controlRevision: revision, paused, healthReason: null,
    }))
  }
  const [desktop, executor] = await Promise.all([attach(hosts[0]!), attach(hosts[1]!)])
  assert.ok(desktop && executor)
  assert.equal(desktop.resourceId, executor.resourceId)
  assert.equal(desktop.capacity, 1)
  assert.equal(await attach(hosts[2]!), null)
  const identity = { hostId: hosts[0]!.id, organizationId, custodianUserId }
  assert.equal(await prisma.$transaction((tx) => setLocalInferenceResourceCapacity(tx, {
    ...identity, capacity: 3, custodianUserId: randomUUID(),
  })), false)
  assert.equal(await prisma.$transaction((tx) => setLocalInferenceResourceCapacity(tx, {
    ...identity, capacity: 3,
  })), true)
  await prisma.$transaction((tx) => controlLocalInferenceResource(tx, { ...identity, action: 'pause' }))
  const pausedHosts = await prisma.localInferenceHost.findMany({ where: { id: { in: [hosts[0]!.id, hosts[1]!.id] } } })
  assert.ok(pausedHosts.every((host) => host.pausedAt))
  const beforeResume = await attach(hosts[0]!)
  assert.ok(beforeResume?.paused)
  await prisma.$transaction((tx) => controlLocalInferenceResource(tx, { ...identity, action: 'resume' }))
  const resumed = await attach(hosts[1]!, beforeResume.controlRevision, true)
  assert.equal(resumed?.paused, false)
  assert.equal(resumed?.capacity, 3)
})
