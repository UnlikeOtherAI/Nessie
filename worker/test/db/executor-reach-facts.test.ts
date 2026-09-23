import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { ExecutorCapabilityDescriptorSchema } from '@nessie/schemas'

import { buildExecutorReachBlock, loadExecutorReachFacts } from '../../src/run/execute/executor-reach-facts.js'
import type { ExecutorLeaseCarryOutcome } from '../../src/run/execute/types.js'
import { runDatabaseTest } from './support.js'

// The machine-reach facts read four things a Prisma fake would only echo back:
// the room's other human members, the bound revision's descriptor, the
// executor's label and the agent's grant rows across machines. Which of them
// reach the model — the label above all — is decided by those queries, so they
// run against real Postgres here.

const LOCAL_APPS = new Set(['executor_mcp_call', 'executor_mcp_tools'])

type World = Awaited<ReturnType<typeof seed>>

const seed = async (prisma: PrismaClient) => {
  const organizationId = randomUUID()
  const [holderId, memberId] = [randomUUID(), randomUUID()]
  await prisma.organization.create({ data: { id: organizationId, name: `reach ${organizationId}` } })
  await prisma.user.createMany({
    data: [holderId, memberId].map((id) => ({ id, email: `${id}@example.test`, displayName: id.slice(0, 8) })),
  })
  // A grant row must be written by a member of the organisation (a trigger).
  await prisma.organizationMember.createMany({
    data: [holderId, memberId].map((userId) => ({ organizationId, role: 'member' as const, userId })),
  })
  const project = await prisma.project.create({ data: { name: 'p', organizationId } })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const room = await prisma.channel.create({
    data: { label: 'room', slug: `room-${randomUUID()}`, organizationId, projectId: project.id, teamId: team.id },
  })
  const dm = await prisma.channel.create({
    data: { dmKey: `reach:${randomUUID()}`, label: 'dm', organizationId, projectId: project.id, teamId: team.id, type: 'dm' },
  })
  await prisma.channelMember.createMany({
    data: [
      { channelId: room.id, userId: holderId },
      { channelId: room.id, userId: memberId },
      { channelId: dm.id, userId: holderId },
    ],
  })
  const agent = await prisma.agent.create({ data: { name: 'CTO', organizationId } })
  const executorFor = async (label: string, status: 'online' | 'revoked') => {
    const executor = await prisma.executor.create({
      data: {
        label, organizationId, pairingOwnerUserId: holderId, profiles: ['workspace_sandbox'],
        scopeKind: 'organization', status,
      },
    })
    const descriptor = ExecutorCapabilityDescriptorSchema.parse({
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 2 },
      localPolicyDigest: `sha256:${'b'.repeat(64)}`,
      mcpServers: ['kelpie', 'coding-sessions'],
      operationKeys: ['mcp.tools', 'mcp.call'],
      platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
      profiles: ['workspace_sandbox'],
      protocolVersion: 1,
      revision: 1,
      sandboxBackend: 'none',
      supervisor: 'service',
    })
    const revision = await prisma.executorCapabilityRevision.create({
      data: {
        descriptor, executorId: executor.id, localPolicyDigest: descriptor.localPolicyDigest,
        reviewStatus: 'active', revision: 1, signature: 'reviewed-test-descriptor',
      },
    })
    return { executorId: executor.id, revisionId: revision.id }
  }
  const minis = await executorFor('Minis', 'online')
  const retired = await executorFor('Old laptop', 'revoked')
  const bindRun = async (channelId: string): Promise<string> => {
    const thread = await prisma.thread.create({ data: { channelId } })
    const run = await prisma.run.create({ data: { agentId: agent.id, status: 'running', threadId: thread.id } })
    await prisma.executorBinding.createMany({
      data: ['mcp.tools', 'mcp.call'].map((operationKey, index) => ({
        authorizationRevision: 1, candidateHandleDigest: `sha256:${randomUUID()}`,
        capabilityRevisionId: minis.revisionId, executorId: minis.executorId, fence: BigInt(index + 1),
        operationKey, runId: run.id,
      })),
    })
    return run.id
  }
  const grant = (executorId: string, operationKey: string) => prisma.executorAgentOperationGrant.create({
    data: {
      agentId: agent.id, authorizationRevision: 1, executorId, operationKey, state: 'allowed', updatedByUserId: holderId,
    },
  })
  const cleanup = async () => {
    await prisma.run.deleteMany({ where: { agentId: agent.id } })
    await prisma.executor.deleteMany({ where: { organizationId } })
    await prisma.thread.deleteMany({ where: { channelId: { in: [room.id, dm.id] } } })
    await prisma.channel.deleteMany({ where: { id: { in: [room.id, dm.id] } } })
    await prisma.agent.deleteMany({ where: { id: agent.id } })
    await prisma.team.deleteMany({ where: { id: team.id } })
    await prisma.project.deleteMany({ where: { id: project.id } })
    await prisma.organizationMember.deleteMany({ where: { organizationId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [holderId, memberId] } } })
  }
  return {
    agentId: agent.id, bindRun, cleanup, dmId: dm.id, grant, holderId, minis, organizationId, retired, roomId: room.id,
  }
}

const withWorld = async (run: (world: World, prisma: PrismaClient) => Promise<void>): Promise<void> => {
  const prisma = new PrismaClient()
  const world = await seed(prisma)
  try {
    await run(world, prisma)
  } finally {
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
}

const carried = (executorId: string): ExecutorLeaseCarryOutcome => ({
  bindingIds: [],
  kind: 'carried',
  lease: { executorId, expiresAt: new Date('2026-09-23T21:40:00.000Z'), id: randomUUID(), live: true },
})

runDatabaseTest('a carried pair names its servers in a shared room and the machine only in the holder’s DM', async () => {
  await withWorld(async (world, prisma) => {
    const inRoom = await loadExecutorReachFacts(prisma, {
      agentId: world.agentId, channelId: world.roomId, hostOutput: null, lease: carried(world.minis.executorId),
      organizationId: world.organizationId, personUserId: world.holderId,
      runId: await world.bindRun(world.roomId), toolNames: LOCAL_APPS,
    })
    // The reserved bridge name is never the pair's to reach.
    assert.deepEqual(inRoom?.kind === 'bound' && inRoom.servers, ['kelpie'])
    assert.equal(inRoom?.kind === 'bound' && inRoom.executorLabel, null)
    assert.doesNotMatch(buildExecutorReachBlock(inRoom) ?? '', /Minis/)

    const inDm = await loadExecutorReachFacts(prisma, {
      agentId: world.agentId, channelId: world.dmId, hostOutput: null, lease: carried(world.minis.executorId),
      organizationId: world.organizationId, personUserId: world.holderId,
      runId: await world.bindRun(world.dmId), toolNames: LOCAL_APPS,
    })
    assert.equal(inDm?.kind === 'bound' && inDm.executorLabel, 'Minis')
    assert.match(buildExecutorReachBlock(inDm) ?? '', /the person's machine, "Minis", through/)
  })
})

runDatabaseTest('only both halves allowed on one live machine tell an unbound agent how to start local apps', async () => {
  await withWorld(async (world, prisma) => {
    const load = () => loadExecutorReachFacts(prisma, {
      agentId: world.agentId, channelId: world.roomId, hostOutput: null, lease: { kind: 'no_lease' },
      organizationId: world.organizationId, personUserId: world.holderId, runId: randomUUID(), toolNames: new Set(),
    })
    assert.equal(await load(), null, 'no grant, nothing to say')
    // Both halves, but on a revoked machine: nobody can launch it.
    await world.grant(world.retired.executorId, 'mcp.tools')
    await world.grant(world.retired.executorId, 'mcp.call')
    // One half on the live machine is not the pair.
    await world.grant(world.minis.executorId, 'mcp.tools')
    assert.equal(await load(), null)
    await world.grant(world.minis.executorId, 'mcp.call')
    assert.deepEqual(await load(), { kind: 'unbound' })
  })
})
