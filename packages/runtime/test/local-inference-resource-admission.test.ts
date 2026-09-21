import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'
import {
  releaseLocalInferenceResource, reserveLocalInferenceResource, settleLocalInferenceAttemptAdmission,
} from '../src/local-inference-resource-admission.js'

const databaseTest = process.env.DATABASE_URL ? test : test.skip

databaseTest('two replicas share one slot; stale time and cancellation cannot release uncertain inference', async (t) => {
  const first = new PrismaClient()
  const second = new PrismaClient()
  const resource = await first.localInferenceResource.create({
    data: { organizationId: randomUUID(), custodianUserId: randomUUID(), publicKey: 'fixture', publicKeyFingerprint: randomUUID() },
  })
  t.after(async () => {
    await first.inferenceResourceAdmission.deleteMany({ where: { resourceId: resource.id } })
    await first.localInferenceResource.delete({ where: { id: resource.id } })
    await Promise.all([first.$disconnect(), second.$disconnect()])
  })
  const contenders = await Promise.all([first, second].map((client) => client.$transaction((tx) =>
    reserveLocalInferenceResource(tx, { resourceId: resource.id, reservationKey: randomUUID() }))))
  const admitted = contenders.find((result) => result.kind === 'admitted')
  assert.ok(admitted && admitted.kind === 'admitted')
  assert.equal(contenders.filter((result) => result.kind === 'admitted').length, 1)
  const attemptId = randomUUID()
  await first.inferenceResourceAdmission.update({
    where: { id: admitted.admission.admissionId },
    data: { state: 'running', attemptId, updatedAt: new Date('2000-01-01') },
  })
  assert.equal(await second.$transaction((tx) => releaseLocalInferenceResource(tx, admitted.admission)), false)
  assert.deepEqual(await second.$transaction((tx) => reserveLocalInferenceResource(tx, {
    resourceId: resource.id, reservationKey: randomUUID(),
  })), { kind: 'waiting', reason: 'capacity' })
  assert.equal(await first.$transaction((tx) => settleLocalInferenceAttemptAdmission(tx, {
    ...admitted.admission, attemptId, confirmed: false,
  })), true)
  assert.deepEqual(await second.$transaction((tx) => reserveLocalInferenceResource(tx, {
    resourceId: resource.id, reservationKey: randomUUID(),
  })), { kind: 'waiting', reason: 'termination_uncertain' })
  assert.equal(await second.$transaction((tx) => settleLocalInferenceAttemptAdmission(tx, {
    ...admitted.admission, attemptId, confirmed: true, fence: randomUUID(),
  })), false)
  assert.equal(await second.$transaction((tx) => settleLocalInferenceAttemptAdmission(tx, {
    ...admitted.admission, attemptId, confirmed: true,
  })), true)
  assert.equal((await second.$transaction((tx) => reserveLocalInferenceResource(tx, {
    resourceId: resource.id, reservationKey: randomUUID(),
  }))).kind, 'admitted')
})

databaseTest('resource pause is checked before replaying an already reserved item', async (t) => {
  const prisma = new PrismaClient()
  const resource = await prisma.localInferenceResource.create({
    data: { organizationId: randomUUID(), custodianUserId: randomUUID(), publicKey: 'fixture', publicKeyFingerprint: randomUUID() },
  })
  t.after(async () => {
    await prisma.inferenceResourceAdmission.deleteMany({ where: { resourceId: resource.id } })
    await prisma.localInferenceResource.delete({ where: { id: resource.id } })
    await prisma.$disconnect()
  })
  const input = { resourceId: resource.id, reservationKey: randomUUID() }
  assert.equal((await prisma.$transaction((tx) => reserveLocalInferenceResource(tx, input))).kind, 'admitted')
  await prisma.localInferenceResource.update({ where: { id: resource.id }, data: { pausedAt: new Date() } })
  assert.deepEqual(await prisma.$transaction((tx) => reserveLocalInferenceResource(tx, input)), {
    kind: 'waiting', reason: 'resource_paused',
  })
})
