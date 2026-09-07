import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  mapMessageRecordWithAttachments,
  messageInclude,
} from '../src/services/message-read-model.js'
import {
  loadAgentActivity,
  loadAgentMessages,
  loadAgentStatus,
  loadRunToolCalls,
} from '../src/services/agent-read-model.js'
import { buildSnapshotForScopes } from '../src/services/agent-read-snapshot.js'
import { canUserReadRunBasis } from '../src/services/run-disclosure.js'
import { loadThreadThinking } from '../src/services/run-thinking.js'
import { seed } from './disclosure-read-fixtures.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

// Every read path that can return an agent's words must ask the same question:
// may *this* viewer read material derived from these scopes? The list endpoint
// always did. These suites pin the paths that did not — the single-message read,
// and the durable thought log — because each was reachable from the product UI
// and each returned content verbatim.

runDatabaseTest('the single-message read withholds content the viewer is not entitled to', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { name: `disclosure-org-${suffix}` } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.$disconnect()
  })

  const s = await seed(prisma, suffix)
  const secret = 'The acquisition closes on the 14th.'
  const message = await prisma.message.create({
    data: {
      agentId: s.agentId,
      content: secret,
      role: 'assistant',
      threadId: s.threadId,
    },
  })
  // Derived from a source scoped to the insider alone.
  await prisma.messageBasisScope.create({
    data: {
      messageId: message.id,
      organizationId: s.organizationId,
      scopeId: s.insiderId,
      scopeType: 'user',
    },
  })

  const row = await prisma.message.findFirstOrThrow({
    where: { id: message.id },
    include: messageInclude,
  })

  const forOutsider = await mapMessageRecordWithAttachments(prisma, row, {
    channelId: s.channelId,
    organizationId: s.organizationId,
    userId: s.outsiderId,
  })
  assert.notEqual(
    forOutsider.content,
    secret,
    'the outsider received the verbatim restricted content',
  )
  assert.ok(
    !JSON.stringify(forOutsider).includes('acquisition'),
    'restricted content leaked through some other field of the DTO',
  )

  const forInsider = await mapMessageRecordWithAttachments(prisma, row, {
    channelId: s.channelId,
    organizationId: s.organizationId,
    userId: s.insiderId,
  })
  assert.equal(forInsider.content, secret, 'the entitled viewer was wrongly withheld')
})

runDatabaseTest('an unrestricted message still reads verbatim for everyone', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { name: `disclosure-org-${suffix}` } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.$disconnect()
  })

  const s = await seed(prisma, suffix)
  const body = 'Standup is at ten.'
  const message = await prisma.message.create({
    data: { agentId: s.agentId, content: body, role: 'assistant', threadId: s.threadId },
  })
  const row = await prisma.message.findFirstOrThrow({
    where: { id: message.id },
    include: messageInclude,
  })

  // The common case, and the one a regression would break loudly: no basis rows
  // means the predicate short-circuits before any query.
  const record = await mapMessageRecordWithAttachments(prisma, row, {
    channelId: s.channelId,
    organizationId: s.organizationId,
    userId: s.outsiderId,
  })
  assert.equal(record.content, body)
})

runDatabaseTest("a run's thought log is withheld from viewers its reply would be withheld from", async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { name: `disclosure-org-${suffix}` } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.$disconnect()
  })

  const s = await seed(prisma, suffix)
  const run = await prisma.run.create({
    data: { agentId: s.agentId, status: 'running', threadId: s.threadId },
  })
  await prisma.runBasisScope.create({
    data: {
      organizationId: s.organizationId,
      runId: run.id,
      scopeId: s.insiderId,
      scopeType: 'user',
    },
  })
  await prisma.runThinkingChunk.create({
    data: { content: 'Checking the private deal memo…', kind: 'reasoning', runId: run.id },
  })

  assert.equal(
    await canUserReadRunBasis(prisma, {
      organizationId: s.organizationId,
      runId: run.id,
      userId: s.outsiderId,
    }),
    false,
  )
  assert.equal(
    await canUserReadRunBasis(prisma, {
      organizationId: s.organizationId,
      runId: run.id,
      userId: s.insiderId,
    }),
    true,
  )

  // The run stays listed either way — the bubble is the honest signal that
  // something is happening — but carries no entries for the outsider.
  const outsiderView = await loadThreadThinking(prisma, s.threadId, {
    organizationId: s.organizationId,
    userId: s.outsiderId,
  })
  assert.equal(outsiderView.runs.length, 1, 'the run should still be listed')
  assert.deepEqual(outsiderView.runs[0]?.entries, [])

  const insiderView = await loadThreadThinking(prisma, s.threadId, {
    organizationId: s.organizationId,
    userId: s.insiderId,
  })
  assert.equal(insiderView.runs[0]?.entries.length, 1)
})

runDatabaseTest('a run that consumed nothing privileged keeps its thought log readable', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { name: `disclosure-org-${suffix}` } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.$disconnect()
  })

  const s = await seed(prisma, suffix)
  const run = await prisma.run.create({
    data: { agentId: s.agentId, status: 'running', threadId: s.threadId },
  })
  await prisma.runThinkingChunk.create({
    data: { content: 'Reading the public roadmap.', kind: 'reasoning', runId: run.id },
  })

  assert.equal(
    await canUserReadRunBasis(prisma, {
      organizationId: s.organizationId,
      runId: run.id,
      userId: s.outsiderId,
    }),
    true,
    'a run with no basis must stay readable — this is the overwhelmingly common case',
  )
})

runDatabaseTest('agent history and tool activity use the same live disclosure gates', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { name: `disclosure-org-${suffix}` } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.$disconnect()
  })

  const s = await seed(prisma, suffix)
  const secret = 'The acquisition closes on the 14th.'
  const restrictedMessage = await prisma.message.create({
    data: { agentId: s.agentId, content: secret, role: 'assistant', threadId: s.threadId },
  })
  await prisma.messageBasisScope.create({
    data: {
      messageId: restrictedMessage.id,
      organizationId: s.organizationId,
      scopeId: s.insiderId,
      scopeType: 'user',
    },
  })
  const restrictedRun = await prisma.run.create({
    data: { agentId: s.agentId, status: 'running', threadId: s.threadId },
  })
  await prisma.runBasisScope.create({
    data: {
      organizationId: s.organizationId,
      runId: restrictedRun.id,
      scopeId: s.insiderId,
      scopeType: 'user',
    },
  })
  await prisma.toolCall.create({
    data: {
      agentId: s.agentId,
      inputSummary: secret,
      outputPreview: secret,
      runId: restrictedRun.id,
      startedAt: new Date(),
      toolName: 'web_search',
    },
  })

  const outsiderVisibility = {
    organizationId: s.organizationId,
    userId: s.outsiderId,
  }
  const insiderVisibility = {
    organizationId: s.organizationId,
    userId: s.insiderId,
  }
  const outsiderHistory = await loadAgentMessages(
    prisma,
    s.agentId,
    25,
    0,
    { visibility: outsiderVisibility },
  )
  assert.equal(outsiderHistory.total, 0)
  assert.ok(!JSON.stringify(outsiderHistory).includes('acquisition'))
  assert.equal(
    (await loadAgentActivity(prisma, s.agentId, { visibility: outsiderVisibility }))
      ?.recentToolCalls.length,
    0,
  )
  assert.equal(
    (await loadAgentStatus(prisma, s.agentId, { visibility: outsiderVisibility }))
      ?.currentRunId,
    undefined,
  )
  assert.equal(
    (await buildSnapshotForScopes(
      prisma,
      [{ agentId: s.agentId, kind: 'agent' }],
      { visibility: outsiderVisibility },
    )).agents[0]?.currentRunId,
    undefined,
  )
  assert.deepEqual(
    await loadRunToolCalls(prisma, s.agentId, restrictedRun.id, { visibility: outsiderVisibility }),
    [],
  )

  const insiderHistory = await loadAgentMessages(
    prisma,
    s.agentId,
    25,
    0,
    { visibility: insiderVisibility },
  )
  assert.equal(insiderHistory.items[0]?.fullContent, secret)
  const insiderTools = await loadRunToolCalls(
    prisma,
    s.agentId,
    restrictedRun.id,
    { visibility: insiderVisibility },
  )
  assert.equal(insiderTools[0]?.outputPreview, secret)

  // A missing basis remains public to everyone who can reach the agent's
  // channel; the gate is provenance-aware, not a blanket activity hide.
  const publicRun = await prisma.run.create({
    data: { agentId: s.agentId, status: 'completed', threadId: s.threadId },
  })
  await prisma.toolCall.create({
    data: {
      agentId: s.agentId,
      inputSummary: 'public input',
      outputPreview: 'public output',
      runId: publicRun.id,
      startedAt: new Date(),
      toolName: 'status',
    },
  })
  const publicTools = await loadRunToolCalls(
    prisma,
    s.agentId,
    publicRun.id,
    { visibility: outsiderVisibility },
  )
  assert.equal(publicTools[0]?.outputPreview, 'public output')
})
