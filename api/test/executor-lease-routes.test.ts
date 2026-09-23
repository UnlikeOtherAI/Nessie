import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  ensureExecutorLogicalTools,
  prepareExecutorAccessChange,
  resolveExecutorAvailabilityCandidates,
} from '@nessie/executor-manage'
import {
  AuthorizedActionContextSchema,
  ExecutorCapabilityDescriptorSchema,
  type AuthorizedActionContext,
  type ImplementedExecutorOperationKey,
} from '@nessie/schemas'

import { registerExecutorRoutes } from '../src/routes/executors.js'
import type { RouteDeps } from '../src/routes/types.js'

/**
 * The lease routes over real rows (docs/plans/2026-09-22-executor-local-apps/
 * conversation-lease.md §4): the conversation read answers only the viewer's
 * own leases, End is the holder's or an executor administrator's and "not
 * found" for anyone else, the machine list is for administrators and names no
 * conversation they could not open, and every change notice goes to the
 * holder's own user scope — from a launch, an End, and a fencing access
 * change alike.
 *
 * The world: an organisation executor "Minis" granted the local-apps pair to
 * one agent in one PRIVATE room whose members are the holder and another
 * member; the organisation owner manages the machine but is not in the room.
 */
const dbTest = process.env.DATABASE_URL ? test : test.skip
const LOCAL_APPS: ImplementedExecutorOperationKey[] = ['mcp.tools', 'mcp.call']

type Published = { data: Record<string, unknown>; event: string; scopes: unknown[] }

type World = {
  adminId: string
  agentId: string
  app: FastifyInstance
  as: (userId: string) => void
  cleanup: () => Promise<void>
  contextFor: (userId: string) => AuthorizedActionContext
  executorId: string
  holderId: string
  memberId: string
  organizationId: string
  prisma: PrismaClient
  published: Published[]
  threadId: string
}

const seed = async (prisma: PrismaClient): Promise<World> => {
  const organizationId = randomUUID()
  const [holderId, memberId, adminId] = [randomUUID(), randomUUID(), randomUUID()]
  const agentId = randomUUID()
  const executorId = randomUUID()
  await prisma.organization.create({ data: { id: organizationId, name: `lease routes ${organizationId}` } })
  await prisma.user.createMany({ data: [
    { id: holderId, email: `${holderId}@example.test`, displayName: 'Holder' },
    { id: memberId, email: `${memberId}@example.test`, displayName: 'Member' },
    { id: adminId, email: `${adminId}@example.test`, displayName: 'Owner' },
  ] })
  await prisma.organizationMember.createMany({ data: [
    { organizationId, userId: holderId, role: 'member' },
    { organizationId, userId: memberId, role: 'member' },
    { organizationId, userId: adminId, role: 'owner' },
  ] })
  const project = await prisma.project.create({ data: { name: 'p', organizationId } })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({ data: {
    label: 'launch-room', slug: `launch-${randomUUID()}`, organizationId, projectId: project.id, teamId: team.id,
    visibility: 'private',
    members: { create: [{ userId: holderId }, { userId: memberId }] },
  } })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const tools = await ensureExecutorLogicalTools(prisma, organizationId)
  await prisma.agent.create({ data: {
    id: agentId, name: 'CTO', organizationId,
    toolPolicy: Object.fromEntries(LOCAL_APPS.map((key) => [tools.get(key)!, true])),
  } })
  await prisma.agentBinding.create({ data: { agentId, channelId: channel.id } })
  await prisma.executor.create({ data: {
    id: executorId, organizationId, pairingOwnerUserId: adminId, label: 'Minis', scopeKind: 'organization',
    status: 'online', lastSeenAt: new Date(), profiles: ['workspace_sandbox'],
  } })
  const descriptor = ExecutorCapabilityDescriptorSchema.parse({
    protocolVersion: 1, revision: 1, profiles: ['workspace_sandbox'], operationKeys: LOCAL_APPS,
    platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
    supervisor: 'service', sandboxBackend: 'none', localPolicyDigest: `sha256:${'5'.repeat(64)}`,
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 2 },
  })
  await prisma.executorCapabilityRevision.create({ data: {
    executorId, revision: 1, descriptor, signature: 'reviewed', localPolicyDigest: descriptor.localPolicyDigest,
    reviewStatus: 'active', reviewedByUserId: adminId,
  } })
  await prisma.executorAgentOperationGrant.createMany({ data: LOCAL_APPS.map((operationKey) => ({
    agentId, authorizationRevision: 1, executorId, operationKey, state: 'allowed' as const, updatedByUserId: adminId,
  })) })

  const contextFor = (userId: string): AuthorizedActionContext => AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: userId }, tenant: { organizationId },
    actionContext: { requestId: randomUUID() },
  })
  let current = holderId
  const published: Published[] = []
  const app = Fastify()
  registerExecutorRoutes(app, {
    buildChannelRealtimeScopes: ({ channelId }: { channelId: string }) => [{ kind: 'channel', channelId }],
    prisma,
    realtimeHub: {
      publishWs: async (scopes: unknown[], input: { data: Record<string, unknown>; event: string }) => {
        published.push({ data: input.data, event: input.event, scopes })
        return { ...input, ts: new Date().toISOString(), type: 'event' }
      },
    },
    requireActorContext: () => contextFor(current),
    requireUserActor: () => true,
  } as unknown as RouteDeps)
  await app.ready()

  const cleanup = async () => {
    await app.close()
    const messages = await prisma.message.findMany({ where: { threadId: thread.id }, select: { id: true } })
    await prisma.queueJob.deleteMany({
      where: { idempotencyKey: { in: messages.map((message) => `run:${message.id}:${agentId}`) } },
    })
    await prisma.task.deleteMany({ where: { organizationId } })
    await prisma.run.deleteMany({ where: { threadId: thread.id } })
    await prisma.executorConversationLease.deleteMany({ where: { organizationId } })
    await prisma.executorContinuation.deleteMany({ where: { executorId } })
    await prisma.executorAvailabilityCandidate.deleteMany({ where: { executorId } })
    await prisma.executor.deleteMany({ where: { id: executorId } })
    await prisma.message.deleteMany({ where: { threadId: thread.id } })
    await prisma.thread.deleteMany({ where: { id: thread.id } })
    await prisma.channel.deleteMany({ where: { id: channel.id } })
    await prisma.agent.deleteMany({ where: { id: agentId } })
    await prisma.team.deleteMany({ where: { id: team.id } })
    await prisma.project.deleteMany({ where: { id: project.id } })
    await prisma.organizationMember.deleteMany({ where: { organizationId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [holderId, memberId, adminId] } } })
  }
  return {
    adminId, agentId, app, as: (userId) => { current = userId }, cleanup, contextFor, executorId, holderId,
    memberId, organizationId, prisma, published, threadId: thread.id,
  }
}

const withWorld = async (run: (world: World) => Promise<void>): Promise<void> => {
  const prisma = new PrismaClient()
  const world = await seed(prisma)
  try {
    await run(world)
  } finally {
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
}

/** The holder launches local apps through the real launch route. */
const launchAsHolder = async (world: World): Promise<string> => {
  world.as(world.holderId)
  const availability = await resolveExecutorAvailabilityCandidates(world.prisma, world.contextFor(world.holderId), {
    agentId: world.agentId, operationKeys: LOCAL_APPS,
  })
  const candidate = availability.candidates[0]
  assert.ok(candidate, JSON.stringify(availability.explanations))
  const response = await world.app.inject({
    method: 'POST', url: `/api/threads/${world.threadId}/executor-runs`,
    payload: { agentId: world.agentId, candidateHandle: candidate.handle, content: 'Open staging', operationKeys: LOCAL_APPS },
  })
  assert.equal(response.statusCode, 201, response.body)
  const lease = await world.prisma.executorConversationLease.findFirstOrThrow({
    where: { threadId: world.threadId, endedAt: null }, select: { id: true },
  })
  return lease.id
}

const leaseNotices = (world: World) => world.published.filter((entry) => entry.event === 'executor.lease.changed')

/** Every notice is addressed to exactly the holder's user scope, and names ids only. */
const assertHolderNotice = (world: World, notice: Published | undefined, leaseId: string) => {
  assert.ok(notice, 'a change notice was published')
  assert.deepEqual(notice.scopes, [{ kind: 'user', organizationId: world.organizationId, userId: world.holderId }])
  assert.deepEqual(notice.data, { leaseId, threadId: world.threadId })
}

const own = async (world: World, userId: string, query = `?threadId=${world.threadId}`) => {
  world.as(userId)
  return world.app.inject({ method: 'GET', url: `/api/executor-leases${query}` })
}

dbTest('the conversation read answers only the viewer’s own lease, and End is the holder’s', async () => {
  await withWorld(async (world) => {
    const leaseId = await launchAsHolder(world)
    assertHolderNotice(world, leaseNotices(world).at(-1), leaseId)

    const mine = await own(world, world.holderId)
    assert.equal(mine.statusCode, 200, mine.body)
    const [lease, ...rest] = mine.json().data
    assert.equal(rest.length, 0)
    assert.equal(lease.id, leaseId)
    assert.equal(lease.agentId, world.agentId)
    assert.equal(lease.executorLabel, 'Minis', 'the holder sees the machine they launched on')
    const row = await world.prisma.executorConversationLease.findUniqueOrThrow({ where: { id: leaseId } })
    assert.equal(lease.launchedAt, row.createdAt.toISOString())
    assert.equal(lease.expiresAt, row.idleExpiresAt.toISOString(), 'the idle window runs out first')

    // A member of the same private room, and the machine's own administrator,
    // ask about the same thread: an empty answer, never a refusal and never
    // the machine's name.
    for (const userId of [world.memberId, world.adminId]) {
      const theirs = await own(world, userId)
      assert.equal(theirs.statusCode, 200)
      assert.deepEqual(theirs.json().data, [])
      assert.equal(theirs.body.includes('Minis'), false)
    }
    assert.equal((await own(world, world.holderId, '')).statusCode, 400)
    assert.equal((await own(world, world.holderId, '?threadId=not-a-uuid')).statusCode, 400)

    // Another member cannot end it, and learns nothing from trying.
    world.as(world.memberId)
    const refused = await world.app.inject({ method: 'POST', url: `/api/executor-leases/${leaseId}/end` })
    assert.equal(refused.statusCode, 404)
    assert.equal(refused.json().error.code, 'EXECUTOR_NOT_FOUND')
    assert.equal((await world.app.inject({ method: 'POST', url: '/api/executor-leases/nope/end' })).statusCode, 404)
    assert.equal(
      (await world.app.inject({ method: 'POST', url: `/api/executor-leases/${randomUUID()}/end` })).statusCode,
      404,
    )
    assert.equal((await world.prisma.executorConversationLease.findUniqueOrThrow({ where: { id: leaseId } })).endedAt, null)

    const noticesBefore = leaseNotices(world).length
    world.as(world.holderId)
    const ended = await world.app.inject({ method: 'POST', url: `/api/executor-leases/${leaseId}/end` })
    assert.equal(ended.statusCode, 200, ended.body)
    assert.deepEqual(ended.json().data, { ended: true, leaseId })
    const after = await world.prisma.executorConversationLease.findUniqueOrThrow({ where: { id: leaseId } })
    assert.equal(after.endedReason, 'person')
    assert.equal(after.endedByUserId, world.holderId)
    assert.equal(leaseNotices(world).length, noticesBefore + 1)
    assertHolderNotice(world, leaseNotices(world).at(-1), leaseId)
    assert.deepEqual((await own(world, world.holderId)).json().data, [])

    // Pressing End again is not an error, and tells nobody anything new.
    world.as(world.holderId)
    const again = await world.app.inject({ method: 'POST', url: `/api/executor-leases/${leaseId}/end` })
    assert.equal(again.statusCode, 200)
    assert.deepEqual(again.json().data, { ended: false, leaseId })
    assert.equal(leaseNotices(world).length, noticesBefore + 1)
  })
})

dbTest('the machine list is for its administrators, who may End a lease the holder then hears about', async () => {
  await withWorld(async (world) => {
    const leaseId = await launchAsHolder(world)
    const url = `/api/executors/${world.executorId}/leases`

    for (const userId of [world.holderId, world.memberId]) {
      world.as(userId)
      const refused = await world.app.inject({ method: 'GET', url })
      assert.equal(refused.statusCode, 404, 'only someone who manages the machine reads its leases')
    }
    world.as(world.adminId)
    assert.equal((await world.app.inject({ method: 'GET', url: '/api/executors/nope/leases' })).statusCode, 404)
    const listed = await world.app.inject({ method: 'GET', url })
    assert.equal(listed.statusCode, 200, listed.body)
    const [row, ...rest] = listed.json().data
    assert.equal(rest.length, 0)
    assert.equal(row.id, leaseId)
    assert.deepEqual(row.agent, { id: world.agentId, name: 'CTO' })
    assert.equal(row.holderUserId, world.holderId)
    assert.equal(row.conversation.threadId, world.threadId)
    assert.equal(row.conversation.label, null, 'the owner is not in the private room, so it goes unnamed')

    // A member of the room would be told its name, if they managed the machine.
    await world.prisma.channelMember.create({
      data: {
        channelId: (await world.prisma.thread.findUniqueOrThrow({ where: { id: world.threadId } })).channelId,
        userId: world.adminId,
      },
    })
    assert.equal((await world.app.inject({ method: 'GET', url })).json().data[0].conversation.label, 'launch-room')

    const ended = await world.app.inject({ method: 'POST', url: `/api/executor-leases/${leaseId}/end` })
    assert.equal(ended.statusCode, 200, ended.body)
    assert.deepEqual(ended.json().data, { ended: true, leaseId })
    const after = await world.prisma.executorConversationLease.findUniqueOrThrow({ where: { id: leaseId } })
    assert.equal(after.endedByUserId, world.adminId)
    assertHolderNotice(world, leaseNotices(world).at(-1), leaseId)
    assert.deepEqual((await world.app.inject({ method: 'GET', url })).json().data, [])
  })
})

dbTest('pausing the machine ends the lease and tells only its holder, without saying so in the reply', async () => {
  await withWorld(async (world) => {
    const leaseId = await launchAsHolder(world)
    world.as(world.adminId)
    const prepared = await prepareExecutorAccessChange(world.prisma, world.contextFor(world.adminId), {
      executorId: world.executorId, change: { kind: 'lifecycle', action: 'pause' },
    })
    assert.equal(prepared.requiresFreshVerification, false)
    const noticesBefore = leaseNotices(world).length
    const confirmed = await world.app.inject({
      method: 'POST', url: `/api/executor-access-changes/${prepared.accessChangeId}/confirm`,
      payload: { confirmationToken: prepared.confirmationToken },
    })
    assert.equal(confirmed.statusCode, 200, confirmed.body)
    assert.deepEqual(Object.keys(confirmed.json().data).sort(), ['authorizationRevision', 'executorId'])
    const after = await world.prisma.executorConversationLease.findUniqueOrThrow({ where: { id: leaseId } })
    assert.equal(after.endedReason, 'executor_paused')
    assert.equal(leaseNotices(world).length, noticesBefore + 1)
    assertHolderNotice(world, leaseNotices(world).at(-1), leaseId)
    assert.deepEqual((await own(world, world.holderId)).json().data, [])
  })
})
