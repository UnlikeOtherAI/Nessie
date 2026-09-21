import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import { settleLocalInferenceAttemptAdmission } from '@nessie/runtime'
import { claimRunForExecution, RunFencedError } from '../run/execute/lifecycle.js'
import { claimTaskSetItem } from './admission.js'
import { executeTaskSet, settleTaskSetItem } from './execute.js'
import type { TaskSetClaim } from './processor.js'
import { seedTaskSetRecoveryFixture } from './recovery-fixture.js'
import { sweepTaskSets, TaskSetBlocked } from './state.js'

const databaseTest = process.env.DATABASE_URL ? test : test.skip
const completed = {
  result: 'Řádek dokončen — 完成',
  disclosure: { classified: true, basisScopes: [], disclosureSources: [] },
}
const claimExecution = async (prisma: PrismaClient, id: string) => {
  const claim = await claimTaskSetItem(prisma, id)
  assert.ok(claim && !('blocked' in claim))
  const execution = await claimRunForExecution(prisma, claim.attempt.runId)
  assert.ok(execution.claimed)
  return { claim, fence: execution.token }
}

/** Saved settlement must touch neither a model, search, files nor transports. */
const settlementOnlyDeps = (prisma: PrismaClient) => new Proxy({ prisma }, {
  get(target, key) {
    assert.equal(key, 'prisma', `Settlement accessed unexpected dependency ${String(key)}`)
    return target.prisma
  },
}) as unknown as Parameters<typeof executeTaskSet>[0]

const pinResource = async (prisma: PrismaClient, claim: TaskSetClaim, running = false) => {
  const resource = await prisma.localInferenceResource.create({ data: {
    organizationId: claim.set.organizationId, custodianUserId: claim.set.ownerUserId,
    publicKey: 'fixture-resource-key', publicKeyFingerprint: randomUUID(),
  } })
  const admission = await prisma.inferenceResourceAdmission.create({ data: {
    resourceId: resource.id, reservationKey: `task-set-test:${randomUUID()}`, runId: claim.attempt.runId,
    state: running ? 'running' : 'reserved', attemptId: running ? randomUUID() : null,
  } })
  await prisma.run.update({ where: { id: claim.attempt.runId }, data: { inferenceResourceAdmissionId: admission.id } })
  return admission
}

for (const stopped of ['paused', 'cancelled'] as const) {
  databaseTest(`a ${stopped} set retains an already completed result without starting the next item`, async (t) => {
    const { prisma, create } = await seedTaskSetRecoveryFixture(t)
    const set = await create()
    const { claim, fence } = await claimExecution(prisma, set.id)
    const admission = await pinResource(prisma, claim)
    await prisma.taskSet.update({ where: { id: set.id }, data: { status: stopped } })
    await prisma.run.update({ where: { id: claim.attempt.runId }, data: { cancelRequestedAt: new Date() } })

    assert.equal(await settleTaskSetItem({ prisma }, claim, fence, completed), true)
    const saved = await prisma.taskSet.findUniqueOrThrow({ where: { id: set.id } })
    assert.equal(saved.status, stopped)
    assert.equal(saved.nextSequence, 2)
    assert.equal(saved.completedItems, 1)
    assert.equal(saved.currentItemId, null)
    const item = await prisma.taskSetItem.findUniqueOrThrow({ where: { id: claim.item.id } })
    assert.equal(item.status, 'completed')
    assert.equal(item.result, completed.result)
    assert.deepEqual(item.resultDisclosure, completed.disclosure)
    assert.equal((await prisma.run.findUniqueOrThrow({ where: { id: claim.attempt.runId } })).status, 'completed')
    assert.equal((await prisma.inferenceResourceAdmission.findUniqueOrThrow({ where: { id: admission.id } })).state, 'released')

    await executeTaskSet(settlementOnlyDeps(prisma), set.id)
    assert.equal(await claimTaskSetItem(prisma, set.id), null)
    assert.equal(await prisma.taskSetAttempt.count({ where: { item: { taskSetId: set.id } } }), 1)
    assert.equal(await prisma.queueJob.count({ where: { idempotencyKey: { startsWith: `task-set:${set.id}:` } } }), 0)
    assert.equal((await prisma.taskSetItem.findFirstOrThrow({ where: { taskSetId: set.id, sequence: 2 } })).status, 'pending')
  })
}

databaseTest('a stale worker cannot release the resource or commit a result after another worker takes over', async (t) => {
  const { prisma, second, create } = await seedTaskSetRecoveryFixture(t)
  const set = await create()
  const { claim, fence } = await claimExecution(prisma, set.id)
  const admission = await pinResource(prisma, claim)
  await prisma.run.update({ where: { id: claim.attempt.runId }, data: {
    executorHeartbeatAt: new Date(Date.now() - 180_000),
  } })
  const takeover = await claimRunForExecution(second, claim.attempt.runId)
  assert.ok(takeover.claimed)
  await assert.rejects(settleTaskSetItem({ prisma }, claim, fence, completed), RunFencedError)
  assert.equal((await second.taskSetItem.findUniqueOrThrow({ where: { id: claim.item.id } })).result, null)
  assert.equal((await second.taskSet.findUniqueOrThrow({ where: { id: set.id } })).nextSequence, 1)
  assert.equal((await second.inferenceResourceAdmission.findUniqueOrThrow({ where: { id: admission.id } })).state, 'reserved')
  assert.equal(await second.queueJob.count({ where: { idempotencyKey: { startsWith: `task-set:${set.id}:` } } }), 0)

  assert.equal(await settleTaskSetItem({ prisma: second }, claim, takeover.token, completed), true)
  await assert.rejects(settleTaskSetItem({ prisma: second }, claim, takeover.token, completed), RunFencedError)
  const saved = await second.taskSet.findUniqueOrThrow({ where: { id: set.id } })
  assert.equal(saved.completedItems, 1)
  assert.equal(saved.nextSequence, 2)
  assert.equal(await second.queueJob.count({ where: { idempotencyKey: { startsWith: `task-set:${set.id}:` } } }), 1)
})

databaseTest('offline and interrupted attempts do not consume the allowance for actual processor failures', async (t) => {
  const { prisma, create } = await seedTaskSetRecoveryFixture(t)
  const set = await create({ maxAttempts: 2 })
  const attempt = async (outcome: Parameters<typeof settleTaskSetItem>[3], pause = false) => {
    await prisma.taskSet.update({ where: { id: set.id }, data: {
      status: 'running', nextAttemptAt: new Date(Date.now() - 1_000),
    } })
    const { claim, fence } = await claimExecution(prisma, set.id)
    if (pause) await prisma.taskSet.update({ where: { id: set.id }, data: { status: 'paused' } })
    assert.equal(await settleTaskSetItem({ prisma }, claim, fence, outcome), true)
    return prisma.taskSet.findUniqueOrThrow({ where: { id: set.id } })
  }
  assert.equal((await attempt({ reason: 'processor_offline', waiting: true, offline: true })).status, 'waiting')
  assert.equal((await attempt({ reason: 'processor_failed', waiting: false })).status, 'waiting')
  assert.equal((await attempt({ reason: 'paused', waiting: true }, true)).status, 'paused')
  const blocked = await attempt({ reason: 'processor_failed', waiting: false })
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.nextSequence, 1)
  assert.equal(blocked.completedItems, 0)
  const item = await prisma.taskSetItem.findFirstOrThrow({ where: { taskSetId: set.id, sequence: 1 } })
  assert.equal(item.status, 'failed')
  assert.equal(item.attempts, 4)
  const history = await prisma.taskSetAttempt.findMany({ where: { itemId: item.id }, orderBy: { number: 'asc' } })
  assert.deepEqual(history.map((entry) => entry.status), ['interrupted', 'failed', 'interrupted', 'failed'])
  await prisma.taskSet.update({ where: { id: set.id }, data: {
    status: 'running', nextAttemptAt: new Date(Date.now() - 1_000),
  } })
  await assert.rejects(claimTaskSetItem(prisma, set.id),
    (error: unknown) => error instanceof TaskSetBlocked && error.reason === 'retry_limit_reached')
  assert.equal(await prisma.taskSetAttempt.count({ where: { itemId: item.id } }), 4)
})

databaseTest('a persisted pending outcome settles after restart and the confirmed-resource sweep remains eligible', async (t) => {
  const { prisma, second, create } = await seedTaskSetRecoveryFixture(t)
  const set = await create()
  const { claim, fence } = await claimExecution(prisma, set.id)
  const admission = await pinResource(prisma, claim, true)
  assert.ok(admission.attemptId)
  const proof = { admissionId: admission.id, fence: admission.fence,
    resourceId: admission.resourceId, attemptId: admission.attemptId }
  await prisma.$transaction((tx) => settleLocalInferenceAttemptAdmission(tx, { ...proof, confirmed: false }))
  assert.equal(await settleTaskSetItem({ prisma }, claim, fence, completed), false)
  assert.equal((await prisma.taskSet.findUniqueOrThrow({ where: { id: set.id } })).status, 'blocked')
  assert.equal(await prisma.userAlert.count({ where: { taskSetId: set.id } }), 1)
  assert.equal((await prisma.taskSetItem.findUniqueOrThrow({ where: { id: claim.item.id } })).result, null)
  assert.equal((await prisma.inferenceResourceAdmission.findUniqueOrThrow({ where: { id: admission.id } })).state, 'uncertain')

  // Close the original connection; recovery must use only the committed rows.
  await prisma.$disconnect()
  const persisted = await second.taskSetAttempt.findUniqueOrThrow({ where: { id: claim.attempt.id } })
  assert.equal(persisted.status, 'settling')
  assert.deepEqual(persisted.pendingOutcome, completed)
  assert.equal((await second.run.findUniqueOrThrow({ where: { id: claim.attempt.runId } })).executorToken, null)
  await second.$transaction((tx) => settleLocalInferenceAttemptAdmission(tx, { ...proof, confirmed: true }))
  await second.taskSet.update({ where: { id: set.id }, data: { nextAttemptAt: new Date(Date.now() - 1_000) } })

  // Bound only sweep discovery to our fixture; every claim/write uses real
  // Postgres transactions and no other suite's due set is touched.
  const scopedSweep = second.$extends({ query: { taskSet: { findMany({ args, query }) {
    return query({ ...args, where: { AND: [args.where ?? {}, { id: set.id }] } })
  } } } })
  await sweepTaskSets(scopedSweep as unknown as PrismaClient)
  const due = await second.taskSet.findUniqueOrThrow({ where: { id: set.id } })
  assert.ok(due.nextAttemptAt.getTime() <= Date.now())
  assert.ok(await second.queueJob.findUnique({ where: { idempotencyKey: `task-set:${set.id}:${due.revision}` } }))
  await executeTaskSet(settlementOnlyDeps(second), set.id)

  const saved = await second.taskSet.findUniqueOrThrow({ where: { id: set.id } })
  assert.equal(saved.status, 'running')
  assert.equal(saved.currentItemId, null)
  assert.equal(saved.nextSequence, 2)
  assert.equal(saved.completedItems, 1)
  assert.equal((await second.taskSetItem.findUniqueOrThrow({ where: { id: claim.item.id } })).result, completed.result)
  assert.equal((await second.taskSetAttempt.findUniqueOrThrow({ where: { id: claim.attempt.id } })).status, 'completed')
  assert.equal((await second.inferenceResourceAdmission.findUniqueOrThrow({ where: { id: admission.id } })).state, 'released')
  assert.equal(await second.taskSetAttempt.count({ where: { item: { taskSetId: set.id } } }), 1)
})
