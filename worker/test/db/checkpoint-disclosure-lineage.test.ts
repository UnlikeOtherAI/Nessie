import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import { persistRunCheckpoint, loadRunCheckpointForRun } from '../../src/run/execute/checkpoint.js'
import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import { admitPrivateConversationLineage } from '../../src/run/execute/private-conversation-lineage.js'
import { runDatabaseTest } from './support.js'

type Fixture = {
  agentId: string
  authorAId: string
  authorBId: string
  channelId: string
  organizationId: string
  runId: string
  taskId: string
  threadId: string
}

const seed = async (prisma: PrismaClient): Promise<Fixture> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: { name: `checkpoint-lineage-${suffix}` },
  })
  const [authorA, authorB] = await Promise.all([
    prisma.user.create({ data: { displayName: 'Source A', email: `checkpoint-a-${suffix}@example.test` } }),
    prisma.user.create({ data: { displayName: 'Source B', email: `checkpoint-b-${suffix}@example.test` } }),
  ])
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, role: 'member', userId: authorA.id },
      { organizationId: organization.id, role: 'member', userId: authorB.id },
    ],
  })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: `private-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      slug: `private-${suffix.slice(0, 8)}`,
      teamId: team.id,
      type: 'standard',
      visibility: 'private',
    },
  })
  await prisma.channelMember.createMany({
    data: [
      { channelId: channel.id, userId: authorA.id },
      { channelId: channel.id, userId: authorB.id },
    ],
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({
    data: { agentKind: 'shared', name: `agent-${suffix}`, organizationId: organization.id },
  })
  const run = await prisma.run.create({
    data: { agentId: agent.id, status: 'pending', threadId: thread.id },
  })
  const task = await prisma.task.create({
    data: { agentId: agent.id, organizationId: organization.id, runId: run.id },
  })
  return {
    agentId: agent.id,
    authorAId: authorA.id,
    authorBId: authorB.id,
    channelId: channel.id,
    organizationId: organization.id,
    runId: run.id,
    taskId: task.id,
    threadId: thread.id,
  }
}

const checkpointInput = (fixture: Fixture, runId: string, disclosureSources: Array<{
  sourceAuthorUserId: string | null
  sourceChannelId: string
}>) => ({
  agentId: fixture.agentId,
  basis: [{ scopeId: fixture.channelId, scopeType: 'channel' }],
  disclosureSources,
  generation: 1,
  note: 'private checkpoint note',
  organizationId: fixture.organizationId,
  reason: 'token_limit' as const,
  rootMessageId: null,
  runId,
  sources: [],
  taskId: fixture.taskId,
  threadId: fixture.threadId,
})

runDatabaseTest('checkpoints preserve known authors, fail closed for legacy rows, and union refresh sources', async (t) => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: fixture.organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [fixture.authorAId, fixture.authorBId] } } })
    await prisma.$disconnect()
  })

  const modernRunId = fixture.runId
  await persistRunCheckpoint(prisma, checkpointInput(fixture, modernRunId, [{
    sourceAuthorUserId: fixture.authorBId,
    sourceChannelId: fixture.channelId,
  }]))
  const modern = await loadRunCheckpointForRun(prisma, {
    rootMessageId: null,
    runId: randomUUID(),
    threadId: fixture.threadId,
  })
  assert.deepEqual(modern?.disclosureSources, [{
    sourceAuthorUserId: fixture.authorBId,
    sourceChannelId: fixture.channelId,
  }])
  const modernSink = createConsumedSourceSink()
  await admitPrivateConversationLineage(prisma, modernSink, modern!)
  assert.deepEqual(modernSink.privateConversationSources(), [{
    sourceAuthorUserId: fixture.authorBId,
    sourceChannelId: fixture.channelId,
  }])

  // A historical checkpoint has only RunBasisScope. It must keep the explicit
  // unknown marker even though another modern checkpoint in this room named B.
  const legacyRun = await prisma.run.create({
    data: { agentId: fixture.agentId, status: 'pending', threadId: fixture.threadId },
  })
  const legacy = await prisma.runCheckpoint.create({
    data: {
      agentId: fixture.agentId,
      generation: 1,
      note: 'legacy private checkpoint note',
      organizationId: fixture.organizationId,
      reason: 'token_limit',
      runId: legacyRun.id,
      taskId: fixture.taskId,
      threadId: fixture.threadId,
    },
  })
  await prisma.runBasisScope.create({
    data: {
      organizationId: fixture.organizationId,
      runId: legacyRun.id,
      scopeId: fixture.channelId,
      scopeType: 'channel',
    },
  })
  const loadedLegacy = await loadRunCheckpointForRun(prisma, {
    rootMessageId: null,
    runId: randomUUID(),
    threadId: fixture.threadId,
  })
  assert.equal(loadedLegacy?.id, legacy.id)
  const legacySink = createConsumedSourceSink()
  await admitPrivateConversationLineage(prisma, legacySink, loadedLegacy!)
  assert.deepEqual(legacySink.privateConversationSources(), [{
    sourceAuthorUserId: null,
    sourceChannelId: fixture.channelId,
  }])

  // Rewriting the same run checkpoint cannot erase B: the transaction unions
  // its extant source rows with newly consumed A before the new note commits.
  await persistRunCheckpoint(prisma, checkpointInput(fixture, modernRunId, [
    { sourceAuthorUserId: fixture.authorAId, sourceChannelId: fixture.channelId },
    { sourceAuthorUserId: fixture.authorBId, sourceChannelId: fixture.channelId },
  ]))
  const modernCheckpoint = await prisma.runCheckpoint.findUniqueOrThrow({ where: { runId: modernRunId } })
  const rows = await prisma.runCheckpointDisclosureSource.findMany({
    orderBy: { sourceAuthorUserId: 'asc' },
    select: { sourceAuthorUserId: true, sourceChannelId: true },
    where: { checkpointId: modernCheckpoint.id },
  })
  assert.deepEqual(rows, [
    fixture.authorAId,
    fixture.authorBId,
  ].sort().map((sourceAuthorUserId) => ({
    sourceAuthorUserId,
    sourceChannelId: fixture.channelId,
  })))
})
