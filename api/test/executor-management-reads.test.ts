import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { PrismaClient } from '@prisma/client'
import Fastify from 'fastify'
import {
  confirmExecutorAccessChange, ensureExecutorLogicalTools, prepareExecutorAccessChange, rejectExecutorAccessChange,
} from '@nessie/executor-manage'
import { AuthorizedActionContextSchema, ExecutorCapabilityDescriptorSchema } from '@nessie/schemas'
import { applyExecutorAgentPolicyChange } from '../src/services/executor-agent-access-policy.js'
import { getExecutorAttentionSummary, listExecutorAgentAccess } from '../src/services/executor-management-reads.js'
import { registerExecutorRoutes } from '../src/routes/executors.js'
import type { RouteDeps } from '../src/routes/types.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip
const signal = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const waitForBlockedTransaction = async (prisma: PrismaClient, blockerPid: number) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [locks] = await prisma.$queryRaw<{ blocked: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_locks WHERE NOT granted AND ${blockerPid} = ANY(pg_blocking_pids(pid))) AS blocked`
    if (locks!.blocked) return
    await delay(10)
  }
  assert.fail('Expected the competing transaction to wait on its database lock')
}
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
    await prisma.executorAgentOperationGrant.create({ data: {
      executorId, agentId: ids[4]!, operationKey: 'coding.attach', state: 'allowed',
      authorizationRevision: 1, updatedByUserId: userId,
    } })
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

dbTest('agent policy and executor access commit together only after a valid continuation', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  const agentId = randomUUID()
  const executorId = randomUUID()
  const secondExecutorId = randomUUID()
  const actor = AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: userId }, tenant: { organizationId },
    actionContext: { requestId: randomUUID() },
  })
  const app = Fastify()
  registerExecutorRoutes(app, {
    prisma, requireActorContext: () => actor, requireUserActor: () => true,
  } as unknown as RouteDeps)
  const prepare = (state: 'allowed' | 'denied') => prepareExecutorAccessChange(prisma, actor, {
    executorId, change: { kind: 'agent_executor_access', agentId, state },
  })
  const snapshot = async () => ({
    agent: await prisma.agent.findUniqueOrThrow({ where: { id: agentId }, select: { toolPolicy: true } }),
    grants: await prisma.executorAgentOperationGrant.findMany({ where: { executorId, agentId } }),
    roster: await prisma.executorPrivateAssignment.findMany({ where: { executorId } }),
    executor: await prisma.executor.findUniqueOrThrow({ where: { id: executorId } }),
  })
  const confirm = (prepared: Awaited<ReturnType<typeof prepare>>, failAfterPolicy = false) =>
    confirmExecutorAccessChange(prisma, actor, {
      ...prepared, freshVerificationSatisfied: true,
    }, async (tx, change) => {
      await applyExecutorAgentPolicyChange(tx, { ...change, organizationId, actorUserId: userId })
      if (failAfterPolicy) throw new Error('Downstream access mutation failed')
    })
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'Atomic executor access test' } })
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, displayName: 'Admin' } })
    await prisma.organizationMember.create({ data: { organizationId, userId, role: 'owner' } })
    const tools = await ensureExecutorLogicalTools(prisma, organizationId)
    const policyKey = tools.get('file.read')!
    await prisma.agent.create({ data: {
      id: agentId, name: agentId, organizationId, toolPolicy: { [policyKey]: true },
    } })
    await prisma.executor.create({ data: {
      id: executorId, organizationId, pairingOwnerUserId: userId,
      label: 'Shared workstation', scopeKind: 'organization', status: 'online',
    } })
    const descriptor = ExecutorCapabilityDescriptorSchema.parse({
      protocolVersion: 1, revision: 1, profiles: ['workspace_sandbox'], operationKeys: ['file.read'],
      platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
      supervisor: 'service', sandboxBackend: 'none', localPolicyDigest: `sha256:${'1'.repeat(64)}`,
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 2 },
    })
    await prisma.executorCapabilityRevision.create({ data: {
      executorId, revision: 1, descriptor, signature: 'test', reviewStatus: 'active',
      localPolicyDigest: descriptor.localPolicyDigest,
    } })
    await prisma.executorAgentOperationGrant.create({ data: {
      executorId, agentId, operationKey: 'file.read', state: 'allowed', authorizationRevision: 1, updatedByUserId: userId,
    } })
    for (const reason of ['wrong_token', 'stale', 'rejected', 'expired'] as const) {
      const prepared = await prepare('denied')
      assert.equal(prepared.requiresFreshVerification, false, 'shared-scope removal preserves its existing gate')
      if (reason === 'stale') await prisma.executor.update({
        where: { id: executorId }, data: { authorizationRevision: { increment: 1 } },
      })
      if (reason === 'rejected') await prisma.executorContinuation.update({
        where: { id: prepared.accessChangeId }, data: { status: 'rejected' },
      })
      if (reason === 'expired') await prisma.executorContinuation.update({
        where: { id: prepared.accessChangeId }, data: { expiresAt: new Date(0) },
      })
      const before = await snapshot()
      const response = await app.inject({
        method: 'POST', url: `/api/executor-access-changes/${prepared.accessChangeId}/confirm`,
        payload: { confirmationToken: reason === 'wrong_token' ? 'x'.repeat(43) : prepared.confirmationToken },
      })
      assert.ok(response.statusCode >= 400 && response.statusCode < 500, `${reason}: ${response.body}`)
      assert.deepEqual(await snapshot(), before, `${reason} cannot mutate policy, grants, roster or authorization`)
    }

    // Confirmation has read pending but cannot pass its executor lock yet.
    // A successful cancellation must win even when confirmation resumes later.
    const cancelled = await prepare('denied')
    const beforeCancel = await snapshot()
    const executorLocked = signal<number>()
    const unlockExecutor = signal<void>()
    const holdingExecutor = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`executor:${executorId}`}, 0))`
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      executorLocked.resolve(backend!.pid)
      await unlockExecutor.promise
    })
    const blockerPid = await executorLocked.promise
    const delayedConfirmation = assert.rejects(confirm(cancelled), /no longer pending/)
    try {
      await waitForBlockedTransaction(prisma, blockerPid)
      await rejectExecutorAccessChange(prisma, actor, cancelled)
    } finally {
      unlockExecutor.resolve()
      await Promise.all([holdingExecutor, delayedConfirmation])
    }
    assert.equal((await prisma.executorContinuation.findUniqueOrThrow({
      where: { id: cancelled.accessChangeId },
    })).status, 'rejected')
    assert.deepEqual(await snapshot(), beforeCancel, 'successful cancellation prevents all delayed access effects')

    // If confirmation claims first, cancellation waits and reports stale; it
    // cannot promise cancellation then have confirmation overwrite that result.
    const winningConfirm = await prepare('denied')
    const policyApplied = signal<number>()
    const completeConfirmation = signal<void>()
    const confirming = confirmExecutorAccessChange(prisma, actor, {
      ...winningConfirm, freshVerificationSatisfied: true,
    }, async (tx, change) => {
      await applyExecutorAgentPolicyChange(tx, { ...change, organizationId, actorUserId: userId })
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      policyApplied.resolve(backend!.pid)
      await completeConfirmation.promise
    })
    const confirmPid = await policyApplied.promise
    const losingRejection = assert.rejects(
      rejectExecutorAccessChange(prisma, actor, winningConfirm), /no longer pending/,
    )
    try {
      await waitForBlockedTransaction(prisma, confirmPid)
    } finally {
      completeConfirmation.resolve()
      await Promise.all([confirming, losingRejection])
    }
    assert.equal((await prisma.executorContinuation.findUniqueOrThrow({
      where: { id: winningConfirm.accessChangeId },
    })).status, 'consumed')
    assert.deepEqual((await snapshot()).agent.toolPolicy, {})
    await confirm(await prepare('allowed'))

    // A later access failure rolls the already-applied policy change back.
    const denied = await prepare('denied')
    const before = await snapshot()
    await assert.rejects(confirm(denied, true), /Downstream access mutation failed/)
    assert.deepEqual(await snapshot(), before)
    await confirm(denied)
    assert.deepEqual((await snapshot()).agent.toolPolicy, {})
    assert.equal((await snapshot()).grants[0]?.state, 'denied')

    // The same transaction enables logical policy before granting a private roster entry.
    await prisma.executor.update({ where: { id: executorId }, data: {
      scopeKind: 'private', privateAssignments: { create: { principalKind: 'user', userId, role: 'admin' } },
    } })
    const allowed = await prepare('allowed')
    assert.equal(allowed.requiresFreshVerification, true)
    await confirm(allowed)
    assert.deepEqual((await snapshot()).agent.toolPolicy, { [policyKey]: true })
    assert.equal((await snapshot()).grants[0]?.state, 'allowed')
    assert.equal(await prisma.executorPrivateAssignment.count({ where: { executorId, agentId } }), 1)

    // Hold the new grant transaction after its policy write. Removal from the
    // old machine must wait before reading grants elsewhere, then see this grant.
    await prisma.executor.create({ data: {
      id: secondExecutorId, organizationId, pairingOwnerUserId: userId,
      label: 'Second machine', scopeKind: 'organization', status: 'online',
    } })
    await prisma.executorCapabilityRevision.create({ data: {
      executorId: secondExecutorId, revision: 1, descriptor, signature: 'test', reviewStatus: 'active',
      localPolicyDigest: descriptor.localPolicyDigest,
    } })
    const addSecond = await prepareExecutorAccessChange(prisma, actor, {
      executorId: secondExecutorId, change: { kind: 'agent_executor_access', agentId, state: 'allowed' },
    })
    const removeFirst = await prepare('denied')
    let releaseAdd!: () => void
    let markPolicyWritten!: () => void
    let markRemoveStarted!: (pid: number) => void
    const mayCommit = new Promise<void>((resolve) => { releaseAdd = resolve })
    const policyWritten = new Promise<void>((resolve) => { markPolicyWritten = resolve })
    const removeStarted = new Promise<number>((resolve) => { markRemoveStarted = resolve })
    const adding = confirmExecutorAccessChange(prisma, actor, {
      ...addSecond, freshVerificationSatisfied: true,
    }, async (tx, change) => {
      await applyExecutorAgentPolicyChange(tx, { ...change, organizationId, actorUserId: userId })
      markPolicyWritten()
      await mayCommit
    })
    await policyWritten
    const removing = confirmExecutorAccessChange(prisma, actor, {
      ...removeFirst, freshVerificationSatisfied: true,
    }, async (tx, change) => {
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      markRemoveStarted(backend!.pid)
      await applyExecutorAgentPolicyChange(tx, { ...change, organizationId, actorUserId: userId })
    })
    try {
      const pid = await removeStarted
      let blocked = false
      for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
        const [locks] = await prisma.$queryRaw<{ blocked: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid = ${pid} AND locktype = 'advisory' AND NOT granted) AS blocked`
        blocked = locks!.blocked
        if (!blocked) await delay(10)
      }
      assert.ok(blocked, 'removal waits on the same agent policy lock while the other grant is uncommitted')
    } finally {
      releaseAdd()
      await Promise.all([adding, removing])
    }
    assert.deepEqual((await snapshot()).agent.toolPolicy, { [policyKey]: true }, 'new machine retains logical tool access')
    assert.equal((await snapshot()).grants.length, 0)
    assert.equal(await prisma.executorAgentOperationGrant.count({
      where: { executorId: secondExecutorId, agentId, state: 'allowed' },
    }), 1)
  } finally {
    try {
      await app.close()
      await prisma.executor.deleteMany({ where: { id: { in: [executorId, secondExecutorId] }, organizationId } })
      await prisma.agent.deleteMany({ where: { id: agentId, organizationId } })
      await prisma.organizationMember.deleteMany({ where: { organizationId } })
      await prisma.user.deleteMany({ where: { id: userId } })
      await prisma.organization.deleteMany({ where: { id: organizationId } })
    } finally { await prisma.$disconnect() }
  }
})
