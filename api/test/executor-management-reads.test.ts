import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'
import Fastify from 'fastify'
import { prepareExecutorAccessChange } from '@nessie/executor-manage'
import { AuthorizedActionContextSchema } from '@nessie/schemas'
import { getExecutorAttentionSummary, listExecutorAgentAccess } from '../src/services/executor-management-reads.js'
import { registerExecutorRoutes } from '../src/routes/executors.js'
import type { RouteDeps } from '../src/routes/types.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip
dbTest('executor agent pages preserve privacy, count filtered rows and page the roster/grant union', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  const otherUserId = randomUUID()
  const executorId = randomUUID()
  const ids = Array.from({ length: 8 }, () => randomUUID())
  const actor = AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: userId }, tenant: { organizationId },
    actionContext: { requestId: randomUUID() },
  })
  const app = Fastify()
  registerExecutorRoutes(app, {
    prisma, requireActorContext: () => actor, requireUserActor: () => true,
  } as unknown as RouteDeps)
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'Executor list test' } })
    await prisma.user.createMany({ data: [userId, otherUserId].map((id) => ({ id, email: `${id}@example.test`, displayName: id })) })
    await prisma.organizationMember.createMany({ data: [
      { organizationId, userId, role: 'owner' }, { organizationId, userId: otherUserId, role: 'owner' },
    ] })
    await prisma.executor.create({ data: {
      id: executorId, organizationId, label: 'Private workstation', scopeKind: 'private', pairingOwnerUserId: userId,
      privateAssignments: { create: { principalKind: 'user', userId, role: 'admin' } },
    } })
    const prepared = await prepareExecutorAccessChange(prisma, actor, {
      executorId, change: { kind: 'lifecycle', action: 'revoke' },
    })
    const reviewUrl = `/api/executor-access-changes/${prepared.accessChangeId}`
    const unavailable = await app.inject({ method: 'GET', url: reviewUrl })
    assert.equal(unavailable.statusCode, 200)
    assert.equal(unavailable.json().data.verificationMethod, 'unavailable')
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: 'test-factor-present' } })
    const supported = await app.inject({ method: 'GET', url: reviewUrl })
    assert.equal(supported.json().data.verificationMethod, 'password')
    assert.equal(supported.body.includes('test-factor-present'), false)
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: null } })
    const names = ['Alpha roster', 'Beta grant', 'Gamma own private', 'Hidden private', 'Add candidate',
      'Hidden candidate', 'System shared', 'Deleted agent']
    await prisma.agent.createMany({ data: ids.map((id, index) => ({
      id, name: names[index]!, organizationId, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      visibility: index === 2 || index === 3 || index === 5 ? 'private' : 'team',
      ownerUserId: index === 2 ? userId : index === 3 || index === 5 ? otherUserId : null,
      systemManaged: index === 6, deletedAt: index === 7 ? new Date() : null,
    })) })
    await prisma.executorPrivateAssignment.createMany({ data: [0, 2, 3, 7].map((index) => ({
      executorId, agentId: ids[index]!, principalKind: 'agent', role: 'use',
    })) })
    await prisma.executorAgentOperationGrant.createMany({ data: [0, 1, 3].map((index) => ({
      executorId, agentId: ids[index]!, operationKey: 'file.read', state: 'allowed',
      authorizationRevision: 1, updatedByUserId: userId,
    })) })
    const first = await listExecutorAgentAccess(prisma, actor, executorId, { limit: 1 })
    const routed = await app.inject({ method: 'GET', url: `/api/executors/${executorId}/agents?limit=1` })
    assert.equal(routed.statusCode, 200)
    assert.deepEqual(routed.json(), first)
    assert.equal(first.meta.total, 3, 'neither another person’s private agent nor a deleted agent leaks in the count')
    assert.deepEqual(first.data, [{
      agentId: ids[0], name: names[0], visibility: 'team', assigned: true, allowedOperationKeys: ['file.read'],
    }])
    assert.ok(first.meta.nextCursor)
    const second = await listExecutorAgentAccess(prisma, actor, executorId, { limit: 1, cursor: first.meta.nextCursor })
    assert.deepEqual(second.data, [{
      agentId: ids[1], name: names[1], visibility: 'team', assigned: false, allowedOperationKeys: ['file.read'],
    }])
    assert.ok(second.meta.prevCursor)
    const previous = await listExecutorAgentAccess(prisma, actor, executorId, {
      limit: 1, cursor: second.meta.prevCursor, direction: 'backward',
    })
    assert.deepEqual(previous.data, first.data)
    const search = await listExecutorAgentAccess(prisma, actor, executorId, { q: 'BETA' })
    assert.equal(search.meta.total, 1)
    assert.equal(search.data[0]?.agentId, ids[1])
    const candidates = await listExecutorAgentAccess(prisma, actor, executorId, {}, true)
    assert.equal(candidates.meta.total, 1, 'linked, hidden, deleted and unsupported system agents are excluded before counting')
    assert.equal(candidates.data[0]?.agentId, ids[4])
    assert.equal((await listExecutorAgentAccess(prisma, actor, executorId, { q: 'Hidden' }, true)).meta.total, 0)
    await prisma.executorAgentOperationGrant.updateMany({ where: { executorId, agentId: ids[1] }, data: { state: 'denied' } })
    assert.equal((await listExecutorAgentAccess(prisma, actor, executorId, {})).meta.total, 2)
    assert.equal((await listExecutorAgentAccess(prisma, actor, executorId, {}, true)).meta.total, 2)
    await prisma.organizationMember.update({
      where: { organizationId_userId: { organizationId, userId } }, data: { role: 'member' },
    })
    assert.equal((await listExecutorAgentAccess(prisma, actor, executorId, {}, true)).meta.total, 0,
      'managing a private executor does not expose otherwise invisible unbound team agents')
    await prisma.organizationMember.update({
      where: { organizationId_userId: { organizationId, userId } }, data: { role: 'owner' },
    })
    await assert.rejects(listExecutorAgentAccess(prisma, { ...actor, actor: { ...actor.actor, actorId: otherUserId } },
      executorId, {}), /Executor not found/)
    await assert.rejects(listExecutorAgentAccess(prisma, actor, executorId, { cursor: 'invalid' }), /Invalid agent page cursor/)

    // Only the latest policy is actionable, regardless of retained history.
    const policy = (revision: number, reviewStatus: 'pending_review' | 'active') => prisma.executorCapabilityRevision.create({
      data: { executorId, revision, reviewStatus, descriptor: {}, localPolicyDigest: 'test', signature: 'test' },
    })
    await prisma.executor.update({ where: { id: executorId }, data: { status: 'offline' } })
    await policy(1, 'pending_review')
    await policy(2, 'active')
    assert.deepEqual(await getExecutorAttentionSummary(prisma, actor), { total: 0, executors: [] })
    await policy(3, 'pending_review')
    assert.deepEqual(await getExecutorAttentionSummary(prisma, actor), {
      total: 1, executors: [{ executorId, policyRevision: 3 }],
    })
    assert.deepEqual(await getExecutorAttentionSummary(prisma, {
      ...actor, actor: { ...actor.actor, actorId: otherUserId },
    }), { total: 0, executors: [] })
    for (const status of ['pending_pairing', 'revoked'] as const) {
      await prisma.executor.update({ where: { id: executorId }, data: { status } })
      assert.deepEqual(await getExecutorAttentionSummary(prisma, actor), { total: 0, executors: [] })
    }
  } finally {
    try {
      await app.close()
      await prisma.executor.deleteMany({ where: { id: executorId, organizationId } })
      await prisma.agent.deleteMany({ where: { id: { in: ids }, organizationId } })
      await prisma.organizationMember.deleteMany({ where: { organizationId } })
      await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } })
      await prisma.organization.deleteMany({ where: { id: organizationId } })
    } finally { await prisma.$disconnect() }
  }
})
