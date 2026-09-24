import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema, ExecutorCapabilityDescriptorSchema } from '@nessie/schemas'
import {
  confirmExecutorAccessChange, ensureExecutorLogicalTools, prepareExecutorAccessChange,
  resolveExecutorAvailabilityCandidates, type ExecutorAccessChange,
} from '../src/index.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('two agents share a private executor and revoking one preserves the other’s access', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  const executorId = randomUUID()
  const agents = [randomUUID(), randomUUID()] as const
  const operationKeys = ['file.read', 'file.write'] as const
  const actor = AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: userId }, tenant: { organizationId },
    actionContext: { requestId: randomUUID() },
  })
  const apply = async (change: ExecutorAccessChange) => {
    const prepared = await prepareExecutorAccessChange(prisma, actor, { executorId, change })
    assert.equal(prepared.requiresFreshVerification, false, 'reviewed machine access needs no second code')
    return confirmExecutorAccessChange(prisma, actor, {
      accessChangeId: prepared.accessChangeId, confirmationToken: prepared.confirmationToken,
      freshVerificationSatisfied: false,
    })
  }
  const availability = (agentId: string) => resolveExecutorAvailabilityCandidates(prisma, actor, {
    agentId, operationKeys: [...operationKeys],
  })
  const grants = (agentId: string) => prisma.executorAgentOperationGrant.findMany({
    where: { executorId, agentId }, orderBy: { operationKey: 'asc' },
    select: { agentId: true, operationKey: true, state: true, authorizationRevision: true },
  })
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'Shared executor test' } })
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, displayName: 'Executor admin' } })
    await prisma.organizationMember.create({ data: { organizationId, userId, role: 'member' } })
    const tools = await ensureExecutorLogicalTools(prisma, organizationId)
    const toolPolicy = Object.fromEntries(operationKeys.map((key) => [tools.get(key)!, true]))
    await prisma.agent.createMany({ data: agents.map((id) => ({ id, name: id, organizationId, toolPolicy })) })
    // Match private pairing's initial roster: one human administrator, no agents.
    await prisma.executor.create({ data: {
      id: executorId, organizationId, pairingOwnerUserId: userId, label: 'One shared workstation',
      scopeKind: 'private', status: 'online', lastSeenAt: new Date(), profiles: ['workspace_sandbox'],
      privateAssignments: { create: { principalKind: 'user', userId, role: 'admin' } },
    } })
    const descriptor = ExecutorCapabilityDescriptorSchema.parse({
      protocolVersion: 1, revision: 1, profiles: ['workspace_sandbox'], operationKeys,
      platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
      supervisor: 'service', sandboxBackend: 'none', localPolicyDigest: `sha256:${'1'.repeat(64)}`,
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 2 },
    })
    await prisma.executorCapabilityRevision.create({ data: {
      executorId, revision: 1, descriptor, signature: 'reviewed-test-descriptor',
      localPolicyDigest: descriptor.localPolicyDigest, reviewStatus: 'active', reviewedByUserId: userId,
    } })

    for (const agentId of agents) {
      await apply({ kind: 'agent_executor_access', agentId, state: 'allowed' })
    }
    assert.equal(await prisma.executorPrivateAssignment.count({
      where: { executorId, principalKind: 'agent' },
    }), 2)
    for (const agentId of agents) {
      assert.deepEqual((await grants(agentId)).map(({ operationKey, state }) => ({ operationKey, state })), [
        { operationKey: 'file.read', state: 'allowed' }, { operationKey: 'file.write', state: 'allowed' },
      ])
      const available = await availability(agentId)
      assert.deepEqual(available.explanations, [])
      assert.equal(available.candidates.length, 1)
      assert.deepEqual(available.candidates[0]!.operationKeys, operationKeys)
    }
    const candidates = await prisma.executorAvailabilityCandidate.findMany({
      where: { executorId, agentId: { in: [...agents] } }, select: { agentId: true, executorId: true },
    })
    assert.deepEqual(new Set(candidates.map((candidate) => candidate.agentId)), new Set(agents))
    assert.ok(candidates.every((candidate) => candidate.executorId === executorId))

    const secondAgentGrants = await grants(agents[1])
    await apply({ kind: 'agent_executor_access', agentId: agents[0], state: 'denied' })
    assert.deepEqual(await grants(agents[0]), [])
    assert.equal(await prisma.executorPrivateAssignment.count({ where: { executorId, agentId: agents[0] } }), 0)
    assert.deepEqual(await grants(agents[1]), secondAgentGrants)
    const revoked = await availability(agents[0])
    assert.deepEqual(revoked.candidates, [])
    assert.deepEqual(revoked.explanations, [{ readiness: 'unavailable', reason: 'scope_mismatch' }])
    const stillAvailable = await availability(agents[1])
    assert.deepEqual(stillAvailable.explanations, [])
    assert.equal(stillAvailable.candidates.length, 1)
    assert.deepEqual(stillAvailable.candidates[0]!.operationKeys, operationKeys)

    // A failed suite grant must roll its new private roster entry back too.
    await prisma.executorCapabilityRevision.updateMany({ where: { executorId }, data: { reviewStatus: 'disabled' } })
    await assert.rejects(apply({ kind: 'agent_executor_access', agentId: agents[0], state: 'allowed' }), /no active reviewed policy/)
    assert.equal(await prisma.executorPrivateAssignment.count({ where: { executorId, agentId: agents[0] } }), 0)
    assert.deepEqual(await grants(agents[1]), secondAgentGrants)
  } finally {
    try {
      await prisma.executor.deleteMany({ where: { id: executorId, organizationId } })
      await prisma.agent.deleteMany({ where: { id: { in: [...agents] }, organizationId } })
      await prisma.organizationMember.deleteMany({ where: { organizationId, userId } })
      await prisma.user.deleteMany({ where: { id: userId } })
      await prisma.organization.deleteMany({ where: { id: organizationId } })
    } finally { await prisma.$disconnect() }
  }
})
