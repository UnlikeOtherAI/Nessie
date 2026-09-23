import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'
import {
  ensureExecutorLogicalTools,
  resolveExecutorAvailabilityCandidates,
} from '@nessie/executor-manage'
import {
  AuthorizedActionContextSchema,
  ExecutorCapabilityDescriptorSchema,
  PERSON_MESSAGE_AUTHORSHIP,
  type AuthorizedActionContext,
  type ImplementedExecutorOperationKey,
} from '@nessie/schemas'
import { createSystemAuthoredMessage } from '@nessie/team-admin'

import { CreateThreadMessageBodySchema } from '../src/contracts/messaging.js'
import { launchExecutorRun } from '../src/services/executor-run-launch.js'
import { createThreadMessage } from '../src/services/message-create.js'

/**
 * The two api halves of the executor conversation lease, against real rows:
 * `launchExecutorRun` opens a lease in its own transaction for the local-apps
 * pair and for nothing else, and `metadata.authorship` — the allowlist marker a
 * lease carries on — is written only by a composer send and can be neither
 * supplied by a client nor relayed through a server-authored row
 * (docs/plans/2026-09-22-executor-local-apps/conversation-lease.md §1, §2.4).
 *
 * Every cleanup is scoped to this seed; no global count is asserted.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const LOCAL_APPS: ImplementedExecutorOperationKey[] = ['mcp.tools', 'mcp.call']

type Seed = {
  actor: AuthorizedActionContext
  agentId: string
  cleanup: () => Promise<void>
  executorId: string
  organizationId: string
  threadId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const organizationId = randomUUID()
  const userId = randomUUID()
  const agentId = randomUUID()
  const executorId = randomUUID()
  await prisma.organization.create({ data: { id: organizationId, name: `lease api ${organizationId}` } })
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, displayName: 'Holder' } })
  await prisma.organizationMember.create({ data: { organizationId, userId, role: 'owner' } })
  const project = await prisma.project.create({ data: { name: 'p', organizationId } })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: { label: 'c', slug: `c-${randomUUID()}`, organizationId, projectId: project.id, teamId: team.id },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const keys: ImplementedExecutorOperationKey[] = [...LOCAL_APPS, 'file.read']
  const tools = await ensureExecutorLogicalTools(prisma, organizationId)
  await prisma.agent.create({
    data: { id: agentId, name: 'CTO', organizationId, toolPolicy: Object.fromEntries(keys.map((key) => [tools.get(key)!, true])) },
  })
  await prisma.agentBinding.create({ data: { agentId, channelId: channel.id } })
  await prisma.executor.create({
    data: {
      id: executorId, organizationId, pairingOwnerUserId: userId, label: 'Minis', scopeKind: 'organization',
      status: 'online', lastSeenAt: new Date(), profiles: ['workspace_sandbox'],
    },
  })
  const descriptor = ExecutorCapabilityDescriptorSchema.parse({
    protocolVersion: 1, revision: 1, profiles: ['workspace_sandbox'], operationKeys: keys,
    platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
    supervisor: 'service', sandboxBackend: 'none', localPolicyDigest: `sha256:${'4'.repeat(64)}`,
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 2 },
  })
  await prisma.executorCapabilityRevision.create({
    data: {
      executorId, revision: 1, descriptor, signature: 'reviewed', localPolicyDigest: descriptor.localPolicyDigest,
      reviewStatus: 'active', reviewedByUserId: userId,
    },
  })
  await prisma.executorAgentOperationGrant.createMany({
    data: keys.map((operationKey) => ({
      agentId, authorizationRevision: 1, executorId, operationKey, state: 'allowed' as const, updatedByUserId: userId,
    })),
  })
  const actor = AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: userId }, tenant: { organizationId },
    actionContext: { requestId: randomUUID() },
  })
  const cleanup = async () => {
    const messages = await prisma.message.findMany({ where: { threadId: thread.id }, select: { id: true } })
    await prisma.queueJob.deleteMany({
      where: { idempotencyKey: { in: messages.map((message) => `run:${message.id}:${agentId}`) } },
    })
    await prisma.task.deleteMany({ where: { organizationId } })
    await prisma.run.deleteMany({ where: { threadId: thread.id } })
    await prisma.executorConversationLease.deleteMany({ where: { organizationId } })
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
    await prisma.user.deleteMany({ where: { id: userId } })
  }
  return { actor, agentId, cleanup, executorId, organizationId, threadId: thread.id, userId }
}

const launch = async (prisma: PrismaClient, world: Seed, operationKeys: ImplementedExecutorOperationKey[]) => {
  const availability = await resolveExecutorAvailabilityCandidates(prisma, world.actor, {
    agentId: world.agentId, operationKeys,
  })
  const candidate = availability.candidates[0]
  assert.ok(candidate, JSON.stringify(availability.explanations))
  const launched = await launchExecutorRun(prisma, world.actor, {
    agentId: world.agentId, candidateHandle: candidate.handle, content: 'Look at the staging site',
    operationKeys, threadId: world.threadId,
  })
  assert.equal(launched.kind, 'launched')
  return launched as Extract<typeof launched, { kind: 'launched' }>
}

runDatabaseTest('a local-apps launch opens its lease in the launch transaction; other bundles do not', async () => {
  const prisma = new PrismaClient()
  const world = await seed(prisma)
  try {
    const launched = await launch(prisma, world, LOCAL_APPS)
    const lease = await prisma.executorConversationLease.findFirstOrThrow({ where: { launchRunId: launched.runId } })
    assert.equal(lease.actorUserId, world.userId)
    assert.equal(lease.agentId, world.agentId)
    assert.equal(lease.executorId, world.executorId)
    assert.equal(lease.rootMessageId, launched.message.id, 'the launch message is the conversation root')
    assert.equal(lease.threadId, world.threadId)
    assert.equal(lease.endedAt, null)
    const bindings = await prisma.executorBinding.findMany({ where: { runId: launched.runId } })
    assert.deepEqual(bindings.map((binding) => binding.leaseId), [lease.id, lease.id])
    const audit = await prisma.auditLog.findMany({
      where: { action: 'executor.lease.created', organizationId: world.organizationId },
    })
    assert.equal(audit.length, 1)
    assert.equal(audit[0]!.resourceId, lease.id)

    // The slot frees when the first launch finishes.
    await prisma.run.update({ where: { id: launched.runId }, data: { status: 'completed' } })
    const other = await launch(prisma, world, ['file.read'])
    assert.equal(await prisma.executorConversationLease.count({ where: { launchRunId: other.runId } }), 0)
    assert.deepEqual(
      (await prisma.executorBinding.findMany({ where: { runId: other.runId } })).map((binding) => binding.leaseId),
      [null],
      'only the local-apps pair is ever carried',
    )
  } finally {
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
})

runDatabaseTest('only a composer send is stamped as the person’s own message', async () => {
  const prisma = new PrismaClient()
  const world = await seed(prisma)
  try {
    const composed = await createThreadMessage(prisma, {
      authorship: PERSON_MESSAGE_AUTHORSHIP, content: 'Deploy it', threadId: world.threadId, userId: world.userId,
    })
    assert.equal(composed.kind, 'created')
    const root = composed.kind === 'created' ? composed.message : null
    assert.equal((root?.metadata as Record<string, unknown>).authorship, 'person')

    const reply = await createThreadMessage(prisma, {
      alsoSendToChannel: true, authorship: PERSON_MESSAGE_AUTHORSHIP, content: 'and tell the team',
      rootMessageId: root!.id, threadId: world.threadId, userId: world.userId,
    })
    assert.equal(reply.kind, 'created')
    if (reply.kind === 'created') {
      assert.equal((reply.message.metadata as Record<string, unknown>).authorship, 'person')
      assert.equal((reply.broadcastMessage?.metadata as Record<string, unknown>).authorship, 'person')
    }

    // The voice hand-off calls the same service without the marker: the text
    // is the voice model's tool call, not something the person typed.
    const handedOff = await createThreadMessage(prisma, {
      content: 'Remind me tomorrow', threadId: world.threadId, userId: world.userId,
    })
    assert.equal(handedOff.kind, 'created')
    assert.equal(
      handedOff.kind === 'created' && 'authorship' in (handedOff.message.metadata as Record<string, unknown>),
      false,
    )
  } finally {
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
})

runDatabaseTest('a client cannot supply authorship and a server-authored row cannot relay it', async () => {
  // The composer body strips unknown keys, so neither a top-level field nor a
  // metadata object reaches `createThreadMessage`.
  const body = CreateThreadMessageBodySchema.parse({
    authorship: 'person', content: 'hi', metadata: { authorship: 'person' },
  }) as Record<string, unknown>
  assert.equal('authorship' in body, false)
  assert.equal('metadata' in body, false)

  const prisma = new PrismaClient()
  const world = await seed(prisma)
  try {
    const relayed = await prisma.$transaction((tx) => createSystemAuthoredMessage(tx, {
      content: 'mirrored', followedByUserIds: [],
      metadata: { authorship: 'person', externalTurn: 'x' } as Prisma.InputJsonValue,
      role: 'user', threadId: world.threadId, userId: world.userId,
    }))
    assert.deepEqual(relayed.metadata, { externalTurn: 'x' })
  } finally {
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
})
