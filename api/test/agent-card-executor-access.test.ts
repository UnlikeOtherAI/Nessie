import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import { ExecutorCapabilityDescriptorSchema } from '@nessie/schemas'
import { prepareWithCard, press, REVIEW_CARD, withSeed, type Seed } from './support/executor-review.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

const accessCard = async (prisma: PrismaClient, s: Seed) => {
  await prisma.agent.update({ where: { id: s.agentId }, data: { ownerUserId: s.userId } })
  const descriptor = ExecutorCapabilityDescriptorSchema.parse({
    protocolVersion: 1, revision: 1, profiles: ['workspace_sandbox'], operationKeys: ['file.read'],
    platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
    supervisor: 'service', sandboxBackend: 'none', localPolicyDigest: `sha256:${'1'.repeat(64)}`,
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 2 },
  })
  await prisma.executorCapabilityRevision.create({ data: {
    executorId: s.executorId, revision: 1, descriptor, signature: 'test',
    localPolicyDigest: descriptor.localPolicyDigest, reviewStatus: 'active', reviewedByUserId: s.userId,
  } })
  const result = await prepareWithCard(prisma, s, {
    kind: 'agent_executor_access', agentId: s.agentId, state: 'allowed',
  })
  assert.equal(result.prepared.requiresFreshVerification, false)
  await prisma.agentCard.update({ where: { id: result.cardId }, data: { spec: {
    ...REVIEW_CARD, title: 'Allow agent access to Studio Mac',
    actions: [{ key: 'allow_access', label: 'Allow access', style: 'primary', submits: true }],
  } } })
  return result
}

dbTest('Allow access grants once, replies in chat and queues the agent without a second code', async (t) => {
  await withSeed(t, async (prisma, s) => {
    const { cardId, prepared } = await accessCard(prisma, s)
    const outsider = await press(prisma, s, cardId, s.otherUserId, [], 'allow_access')
    assert.equal(outsider.statusCode, 403)
    assert.equal(await prisma.executorAgentOperationGrant.count({ where: { executorId: s.executorId } }), 0)

    const responses = await Promise.all([
      press(prisma, s, cardId, s.userId, [], 'allow_access'),
      press(prisma, s, cardId, s.userId, [], 'allow_access'),
    ])
    assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409])
    const success = responses.find((r) => r.statusCode === 200)!.json().data
    assert.equal(success.status, 'resolved')
    assert.ok(success.responseMessageId)
    assert.equal(success.executorReview, undefined)
    assert.equal((await prisma.executorContinuation.findUniqueOrThrow({ where: { id: prepared.accessChangeId } })).status, 'consumed')
    assert.equal(await prisma.executorPrivateAssignment.count({ where: { executorId: s.executorId, agentId: s.agentId } }), 1)
    assert.equal(await prisma.executorAgentOperationGrant.count({ where: { executorId: s.executorId, state: 'allowed' } }), 1)
    const answer = await prisma.message.findUniqueOrThrow({ where: { id: success.responseMessageId } })
    assert.equal(answer.role, 'user')
    assert.equal(answer.threadId, s.threadId)
    assert.equal(await prisma.queueJob.count({ where: {
      topic: 'orchestrate.decide', payload: { path: ['messageId'], equals: answer.id },
    } }), 1)
  })
})

dbTest('a stale or unreviewed machine grants nothing and leaves its card unanswered', async (t) => {
  await withSeed(t, async (prisma, s) => {
    const { cardId } = await accessCard(prisma, s)
    await prisma.executorCapabilityRevision.updateMany({ where: { executorId: s.executorId }, data: { reviewStatus: 'disabled' } })
    const response = await press(prisma, s, cardId, s.userId, [], 'allow_access')
    assert.equal(response.statusCode, 409, response.body)
    assert.equal((await prisma.agentCard.findUniqueOrThrow({ where: { id: cardId } })).status, 'open')
    assert.equal(await prisma.executorPrivateAssignment.count({ where: { executorId: s.executorId, agentId: s.agentId } }), 0)
    assert.equal(await prisma.executorAgentOperationGrant.count({ where: { executorId: s.executorId } }), 0)
    await prisma.executor.update({ where: { id: s.executorId }, data: { authorizationRevision: { increment: 1 } } })
    assert.equal((await press(prisma, s, cardId, s.userId, [], 'allow_access')).statusCode, 409)
  })
})
