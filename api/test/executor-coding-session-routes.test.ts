import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient, type Prisma } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  AuthorizedActionContextSchema,
  ExecutorCapabilityDescriptorSchema,
  ExecutorCodingSessionListResponseSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { registerExecutorRoutes } from '../src/routes/executors.js'
import type { RouteDeps } from '../src/routes/types.js'

/**
 * The executor page's coding sessions over real rows
 * (docs/executor-protocol/host-coding-sessions.md → "The executor page"): the
 * list is the machine's last report for the people who manage it, naming the
 * driving agent only where the reader could see it and saying which sessions
 * a close is already on its way to; Close is the pairing owner's alone, for a
 * session that report lists as theirs, and is accepted with 202.
 *
 * The world: a private executor "Workstation" paired by its owner, with a
 * second administrator on its roster and an organisation member who is not.
 * The owner bound the local-apps pair there for two agents — "CTO", seen only
 * in a private room the owner alone is in, and "Researcher", working in a
 * public room.
 */
const dbTest = process.env.DATABASE_URL ? test : test.skip

type World = {
  app: FastifyInstance
  as: (userId: string) => void
  cleanup: () => Promise<void>
  coadminId: string
  ctoKey: string
  executorId: string
  outsiderId: string
  ownerId: string
  prisma: PrismaClient
  researcherKey: string
  sessions: { closed: string; cto: string; researcher: string; stranger: string }
}

const ownerKeyOf = (executorId: string, agentId: string, actorUserId: string): string =>
  `sha256:${createHash('sha256').update(`${executorId}|${agentId}|${actorUserId}`).digest('hex')}`

const STRANGER_KEY = `sha256:${'e'.repeat(64)}`

const seed = async (prisma: PrismaClient): Promise<World> => {
  const organizationId = randomUUID()
  const [ownerId, coadminId, outsiderId] = [randomUUID(), randomUUID(), randomUUID()]
  const [ctoId, researcherId] = [randomUUID(), randomUUID()]
  const executorId = randomUUID()
  await prisma.organization.create({ data: { id: organizationId, name: `coding session routes ${organizationId}` } })
  await prisma.user.createMany({ data: [
    { id: ownerId, email: `${ownerId}@example.test`, displayName: 'Owner' },
    { id: coadminId, email: `${coadminId}@example.test`, displayName: 'Co-admin' },
    { id: outsiderId, email: `${outsiderId}@example.test`, displayName: 'Outsider' },
  ] })
  await prisma.organizationMember.createMany({ data: [ownerId, coadminId, outsiderId].map((userId) => ({
    organizationId, role: 'member' as const, userId,
  })) })
  const project = await prisma.project.create({ data: { name: 'p', organizationId } })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const privateRoom = await prisma.channel.create({ data: {
    label: 'cto', slug: `cto-${randomUUID()}`, organizationId, projectId: project.id, teamId: team.id,
    visibility: 'private', members: { create: [{ userId: ownerId }] },
  } })
  const publicRoom = await prisma.channel.create({ data: {
    label: 'research', slug: `research-${randomUUID()}`, organizationId, projectId: project.id, teamId: team.id,
  } })
  await prisma.agent.createMany({ data: [
    { id: ctoId, name: 'CTO', organizationId },
    { id: researcherId, name: 'Researcher', organizationId },
  ] })
  await prisma.agentBinding.createMany({ data: [
    { agentId: ctoId, channelId: privateRoom.id },
    { agentId: researcherId, channelId: publicRoom.id },
  ] })
  const sessions = { closed: randomUUID(), cto: randomUUID(), researcher: randomUUID(), stranger: randomUUID() }
  const ctoKey = ownerKeyOf(executorId, ctoId, ownerId)
  const researcherKey = ownerKeyOf(executorId, researcherId, ownerId)
  const observedAt = new Date().toISOString()
  const listed = (sessionId: string, ownerKey: string, title: string, status: string) => ({
    agent: 'claude', ownerKey, root: 'nessie', sessionId, status, title, updatedAt: observedAt,
  })
  await prisma.executor.create({ data: {
    id: executorId, label: 'Workstation', organizationId, pairingOwnerUserId: ownerId, profiles: ['workspace_sandbox'],
    scopeKind: 'private', status: 'online', lastSeenAt: new Date(),
    privateAssignments: { create: [
      { principalKind: 'user', role: 'admin', userId: ownerId },
      { principalKind: 'user', role: 'admin', userId: coadminId },
    ] },
    localMcp: [{
      available: true,
      codingSessions: [
        listed(sessions.cto, ctoKey, 'Fix the pricing page', 'working'),
        listed(sessions.researcher, researcherKey, 'Summarise the benchmarks', 'waiting_for_input'),
        listed(sessions.stranger, STRANGER_KEY, 'An older session', 'interrupted'),
        listed(sessions.closed, ctoKey, 'Already finished', 'closed'),
      ],
      observedAt,
      server: 'coding-sessions',
    }] as unknown as Prisma.InputJsonValue,
    localMcpObservedAt: new Date(observedAt),
  } })
  const descriptor = ExecutorCapabilityDescriptorSchema.parse({
    protocolVersion: 1, revision: 1, profiles: ['workspace_sandbox'], operationKeys: ['mcp.tools', 'mcp.call'],
    platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
    supervisor: 'desktop', sandboxBackend: 'none', localPolicyDigest: `sha256:${'7'.repeat(64)}`,
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 2 },
  })
  const revision = await prisma.executorCapabilityRevision.create({ data: {
    executorId, revision: 1, descriptor, signature: 'reviewed', localPolicyDigest: descriptor.localPolicyDigest,
    reviewStatus: 'active', reviewedByUserId: ownerId,
  } })
  // What a binding leaves behind: the consumed choice that names the person
  // and the agent, from which the owner key is derived again.
  await prisma.executorAvailabilityCandidate.createMany({ data: [ctoId, researcherId].map((agentId) => ({
    actorUserId: ownerId, agentId, authorizationRevision: 1, capabilityRevisionId: revision.id,
    consumedAt: new Date(), executorId, expiresAt: new Date(Date.now() + 60_000),
    handleDigest: randomUUID(), operationKeys: ['mcp.tools', 'mcp.call'],
  })) })

  const contextFor = (userId: string): AuthorizedActionContext => AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: userId }, tenant: { organizationId },
    actionContext: { requestId: randomUUID() },
  })
  let current = ownerId
  const app = Fastify()
  registerExecutorRoutes(app, {
    prisma,
    requireActorContext: () => contextFor(current),
    requireUserActor: () => true,
  } as unknown as RouteDeps)
  await app.ready()
  const cleanup = async () => {
    await app.close()
    await prisma.executorAvailabilityCandidate.deleteMany({ where: { executorId } })
    await prisma.executor.deleteMany({ where: { id: executorId } })
    await prisma.channel.deleteMany({ where: { id: { in: [privateRoom.id, publicRoom.id] } } })
    await prisma.agent.deleteMany({ where: { id: { in: [ctoId, researcherId] } } })
    await prisma.team.deleteMany({ where: { id: team.id } })
    await prisma.project.deleteMany({ where: { id: project.id } })
    await prisma.organizationMember.deleteMany({ where: { organizationId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, coadminId, outsiderId] } } })
  }
  return {
    app, as: (userId) => { current = userId }, cleanup, coadminId, ctoKey, executorId, outsiderId, ownerId, prisma,
    researcherKey, sessions,
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

const list = async (world: World, userId: string) => {
  world.as(userId)
  return world.app.inject({ method: 'GET', url: `/api/executors/${world.executorId}/coding-sessions` })
}

const listed = async (world: World, userId: string) => {
  const response = await list(world, userId)
  assert.equal(response.statusCode, 200, response.body)
  return ExecutorCodingSessionListResponseSchema.parse((response.json() as { data: unknown }).data)
}

const close = (world: World, userId: string, payload: Record<string, unknown>) => {
  world.as(userId)
  return world.app.inject({ method: 'POST', payload, url: `/api/executors/${world.executorId}/coding-sessions/close` })
}

dbTest('the list is the last report’s open sessions, naming only agents the reader could see', async () => {
  await withWorld(async (world) => {
    // An owner-wide ask already on its way reaches every session of that owner.
    await world.prisma.executorCodingSessionCloseRequest.create({ data: {
      executorId: world.executorId, ownerKey: world.researcherKey, reason: 'lease_ended',
    } })
    const owner = await listed(world, world.ownerId)
    assert.equal(owner.canClose, true)
    assert.deepEqual(owner.sessions.map((session) => [session.sessionId, session.ownerAgentName, session.closing]), [
      [world.sessions.cto, 'CTO', false],
      [world.sessions.researcher, 'Researcher', true],
      [world.sessions.stranger, null, false],
    ], 'report order, the closed session left out, an owner key no binding explains named by nobody')
    assert.equal(owner.sessions[0]?.title, 'Fix the pricing page')
    assert.equal(owner.sessions[0]?.ownerKey, world.ctoKey)

    const coadmin = await listed(world, world.coadminId)
    assert.equal(coadmin.canClose, false, 'managing the machine is not being the person the sessions act as')
    assert.deepEqual(coadmin.sessions.map((session) => session.ownerAgentName), [null, 'Researcher', null],
      'the CTO works only in a room this administrator is not in')

    assert.equal((await list(world, world.outsiderId)).statusCode, 404)
  })
})

dbTest('the pairing owner’s Close is accepted, and that row reads as closing while the request is open', async () => {
  await withWorld(async (world) => {
    const response = await close(world, world.ownerId, { ownerKey: world.ctoKey, sessionId: world.sessions.cto })
    assert.equal(response.statusCode, 202, response.body)
    assert.deepEqual((response.json() as { data: unknown }).data, { closing: true, sessionId: world.sessions.cto })
    const rows = await world.prisma.executorCodingSessionCloseRequest.findMany({ where: { executorId: world.executorId } })
    assert.deepEqual(rows.map((row) => [row.ownerKey, row.sessionId, row.reason, row.requestedByUserId, row.resolvedAt]), [
      [world.ctoKey, world.sessions.cto, 'person', world.ownerId, null],
    ])
    const after = await listed(world, world.ownerId)
    assert.deepEqual(after.sessions.map((session) => session.closing), [true, false, false], 'that session only')
    const again = await close(world, world.ownerId, { ownerKey: world.ctoKey, sessionId: world.sessions.cto })
    assert.equal(again.statusCode, 202, 'pressing twice is the same request')
    assert.equal(await world.prisma.executorCodingSessionCloseRequest.count({ where: { executorId: world.executorId } }), 1)

    // A request past its day is settled by the next heartbeat whatever the
    // machine says, so it stops reading as closing here too.
    await world.prisma.executorCodingSessionCloseRequest.updateMany({
      where: { executorId: world.executorId }, data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1_000) },
    })
    assert.deepEqual((await listed(world, world.ownerId)).sessions.map((session) => session.closing), [false, false, false])

    // The next report no longer carries it, and neither does the list.
    const row = await world.prisma.executor.findUniqueOrThrow({ where: { id: world.executorId }, select: { localMcp: true } })
    const [bridge] = row.localMcp as Array<{ codingSessions: Array<{ sessionId: string }> }>
    assert.ok(bridge)
    bridge.codingSessions = bridge.codingSessions.filter((session) => session.sessionId !== world.sessions.cto)
    await world.prisma.executor.update({
      where: { id: world.executorId }, data: { localMcp: [bridge] as unknown as Prisma.InputJsonValue },
    })
    assert.deepEqual((await listed(world, world.ownerId)).sessions.map((session) => session.sessionId), [
      world.sessions.researcher, world.sessions.stranger,
    ])
  })
})

dbTest('Close is refused to everyone but the pairing owner, and for anything the report does not list', async () => {
  await withWorld(async (world) => {
    const body = { ownerKey: world.ctoKey, sessionId: world.sessions.cto }
    const coadmin = await close(world, world.coadminId, body)
    assert.equal(coadmin.statusCode, 403, coadmin.body)
    assert.equal((coadmin.json() as { error: { code: string } }).error.code, 'EXECUTOR_CODING_SESSIONS_OWNER_ONLY')
    const outsider = await close(world, world.outsiderId, body)
    assert.equal(outsider.statusCode, 404)
    assert.equal((outsider.json() as { error: { code: string } }).error.code, 'EXECUTOR_NOT_FOUND')
    for (const unlisted of [
      { ...body, sessionId: randomUUID() },
      { ...body, ownerKey: world.researcherKey },
      { ...body, sessionId: world.sessions.closed },
    ]) {
      const refused = await close(world, world.ownerId, unlisted)
      assert.equal(refused.statusCode, 404, refused.body)
      assert.equal((refused.json() as { error: { code: string } }).error.code, 'EXECUTOR_CODING_SESSION_NOT_FOUND')
    }
    for (const malformed of [{ ...body, ownerKey: 'owner-a' }, { sessionId: world.sessions.cto }, { ...body, reason: 'person' }]) {
      assert.equal((await close(world, world.ownerId, malformed)).statusCode, 400)
    }
    assert.equal(await world.prisma.executorCodingSessionCloseRequest.count({ where: { executorId: world.executorId } }), 0)
  })
})

dbTest('on a shared machine not even the person who paired it may Close: no session there runs as anyone', async () => {
  await withWorld(async (world) => {
    const organizationId = (await world.prisma.executor.findUniqueOrThrow({
      where: { id: world.executorId }, select: { organizationId: true },
    })).organizationId
    // An organisation administrator manages an organisation executor.
    await world.prisma.organizationMember.updateMany({
      where: { organizationId, userId: world.ownerId }, data: { role: 'admin' },
    })
    await world.prisma.executor.update({ where: { id: world.executorId }, data: { scopeKind: 'organization' } })
    assert.equal((await listed(world, world.ownerId)).canClose, false)
    const refused = await close(world, world.ownerId, { ownerKey: world.ctoKey, sessionId: world.sessions.cto })
    assert.equal(refused.statusCode, 403, refused.body)
    assert.equal((refused.json() as { error: { code: string } }).error.code, 'EXECUTOR_CODING_SESSIONS_OWNER_ONLY')
    assert.equal(await world.prisma.executorCodingSessionCloseRequest.count({ where: { executorId: world.executorId } }), 0)
  })
})

dbTest('a machine that has not asked its bridge lists nothing, and says who may Close', async () => {
  await withWorld(async (world) => {
    await world.prisma.executor.update({
      where: { id: world.executorId },
      data: { localMcp: [{ available: true, observedAt: new Date().toISOString(), server: 'coding-sessions' }] },
    })
    assert.deepEqual(await listed(world, world.ownerId), { canClose: true, sessions: [] })
    assert.deepEqual(await listed(world, world.coadminId), { canClose: false, sessions: [] })
  })
})
