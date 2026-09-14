import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  loadAgentActivity,
  loadAgentMessages,
  loadRunToolCalls,
} from '../src/services/agent-read-model.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest('an org-owner agent creator cannot read a private human source channel', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { name: `owner-source-org-${suffix}` } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.$disconnect()
  })

  const organization = await prisma.organization.create({
    data: { name: `owner-source-org-${suffix}` },
  })
  const project = await prisma.project.create({
    data: { name: `p-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `t-${suffix}`, projectId: project.id },
  })
  const creator = await prisma.user.create({
    data: { displayName: 'agent creator', email: `creator-${suffix}@example.com` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: creator.id },
  })
  const sourceAuthor = await prisma.user.create({
    data: { displayName: 'source author', email: `author-${suffix}@example.com` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'member', userId: sourceAuthor.id },
  })
  const privateChannel = await prisma.channel.create({
    data: {
      label: `private-${suffix}`,
      slug: `private-${suffix.slice(0, 8)}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
      type: 'standard',
      visibility: 'private',
    },
  })
  await prisma.channelMember.create({
    data: { channelId: privateChannel.id, userId: sourceAuthor.id },
  })
  const thread = await prisma.thread.create({ data: { channelId: privateChannel.id } })
  const agent = await prisma.agent.create({
    data: {
      name: `creator-agent-${suffix}`,
      organizationId: organization.id,
      ownerUserId: creator.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const privateCanary = 'private-human-source-canary'
  await prisma.message.create({
    data: { content: privateCanary, role: 'user', threadId: thread.id, userId: sourceAuthor.id },
  })
  const run = await prisma.run.create({
    data: { agentId: agent.id, status: 'running', threadId: thread.id },
  })
  await prisma.toolCall.create({
    data: {
      agentId: agent.id,
      inputSummary: privateCanary,
      outputPreview: privateCanary,
      runId: run.id,
      startedAt: new Date(),
      toolName: 'web_search',
    },
  })

  const ownerVisibility = {
    includeAllOrgChannels: true,
    organizationId: organization.id,
    uoaIdentity: undefined,
    userId: creator.id,
  }
  const history = await loadAgentMessages(prisma, agent.id, {
    cursorSecret: 'test-history-secret',
    limit: 25,
    visibility: ownerVisibility,
  })
  assert.equal(history.data.items.length, 0)
  assert.doesNotMatch(JSON.stringify(history), new RegExp(privateCanary))
  const activity = await loadAgentActivity(prisma, agent.id, { visibility: ownerVisibility })
  assert.equal(activity?.recentToolCalls.length, 0)
  assert.deepEqual(
    await loadRunToolCalls(prisma, agent.id, run.id, { visibility: ownerVisibility }),
    [],
  )
})

