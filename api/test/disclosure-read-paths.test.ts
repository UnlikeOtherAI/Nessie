import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { mapMessageRecordWithAttachments, messageInclude } from '../src/services/messages.js'
import { canReadRunThinking } from '../src/services/run-thinking-disclosure.js'
import { loadThreadThinking } from '../src/services/run-thinking.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

// Every read path that can return an agent's words must ask the same question:
// may *this* viewer read material derived from these scopes? The list endpoint
// always did. These suites pin the paths that did not — the single-message read,
// and the durable thought log — because each was reachable from the product UI
// and each returned content verbatim.

type Seed = {
  organizationId: string
  projectId: string
  teamId: string
  channelId: string
  threadId: string
  agentId: string
  insiderId: string
  outsiderId: string
}

// One organisation, one channel, two people in it, and one agent. `insider` is
// additionally a member of the private channel a restricted reply is derived
// from; `outsider` is not. Both can see the thread the reply lands in — that is
// the whole point: thread visibility is not entitlement to the content.
const seed = async (prisma: PrismaClient, suffix: string): Promise<Seed> => {
  const organization = await prisma.organization.create({
    data: { name: `disclosure-org-${suffix}` },
  })
  const project = await prisma.project.create({
    data: { name: `p-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `t-${suffix}`, projectId: project.id },
  })
  const channel = await prisma.channel.create({
    data: {
      label: `c-${suffix}`,
      // `channels_standard_slug_required` — a standard channel must be addressable.
      slug: `c-${suffix.slice(0, 8)}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
      type: 'standard',
      visibility: 'public',
    },
  })
  const thread = await prisma.thread.create({
    data: { channelId: channel.id, title: 'main' },
  })
  const agent = await prisma.agent.create({
    data: {
      name: `a-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })

  const makeUser = async (role: string) => {
    const user = await prisma.user.create({
      data: { email: `${role}-${suffix}@example.com`, displayName: role },
    })
    await prisma.organizationMember.create({
      data: { organizationId: organization.id, userId: user.id, role: 'member' },
    })
    await prisma.channelMember.create({ data: { channelId: channel.id, userId: user.id } })
    return user.id
  }

  return {
    agentId: agent.id,
    channelId: channel.id,
    insiderId: await makeUser('insider'),
    organizationId: organization.id,
    outsiderId: await makeUser('outsider'),
    projectId: project.id,
    teamId: team.id,
    threadId: thread.id,
  }
}

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
    await canReadRunThinking(prisma, {
      organizationId: s.organizationId,
      runId: run.id,
      userId: s.outsiderId,
    }),
    false,
  )
  assert.equal(
    await canReadRunThinking(prisma, {
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
    await canReadRunThinking(prisma, {
      organizationId: s.organizationId,
      runId: run.id,
      userId: s.outsiderId,
    }),
    true,
    'a run with no basis must stay readable — this is the overwhelmingly common case',
  )
})
