import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { inheritAgentCardResponseBasis } from '@nessie/team-admin'

import {
  mapMessageRecordWithAttachments,
  messageInclude,
} from '../src/services/message-read-model.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  agentId: string
  channelId: string
  insiderId: string
  organizationId: string
  outsiderId: string
  projectId: string
  teamId: string
  threadId: string
}

const seed = async (prisma: PrismaClient, suffix: string): Promise<Seed> => {
  const organization = await prisma.organization.create({ data: { name: `card-basis-${suffix}` } })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: `channel-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      slug: `card-${suffix.slice(0, 8)}`,
      teamId: team.id,
      type: 'standard',
      visibility: 'public',
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id, title: 'main' } })
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const makeUser = async (role: string): Promise<string> => {
    const user = await prisma.user.create({
      data: { displayName: role, email: `${role}-${suffix}@example.test` },
    })
    await prisma.organizationMember.create({
      data: { organizationId: organization.id, role: 'member', userId: user.id },
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

const submitCardResponse = async (
  prisma: PrismaClient,
  seedData: Seed,
  input: { content: string; sourceBasis: readonly { scopeId: string; scopeType: string }[] },
): Promise<string> => prisma.$transaction(async (tx) => {
  const source = await tx.message.create({
    data: { agentId: seedData.agentId, content: 'Compose email', role: 'assistant', threadId: seedData.threadId },
  })
  if (input.sourceBasis.length > 0) {
    await tx.messageBasisScope.createMany({
      data: input.sourceBasis.map((scope) => ({
        messageId: source.id,
        organizationId: seedData.organizationId,
        scopeId: scope.scopeId,
        scopeType: scope.scopeType,
      })),
    })
  }
  const run = await tx.run.create({
    data: { agentId: seedData.agentId, status: 'running', threadId: seedData.threadId },
  })
  const card = await tx.agentCard.create({
    data: {
      agentId: seedData.agentId,
      channelId: seedData.channelId,
      messageId: source.id,
      organizationId: seedData.organizationId,
      respondentUserIds: [],
      runId: run.id,
      spec: {},
      threadId: seedData.threadId,
    },
  })
  const response = await tx.message.create({
    data: {
      content: input.content,
      role: 'user',
      rootMessageId: source.id,
      threadId: seedData.threadId,
      userId: seedData.insiderId,
    },
  })
  await inheritAgentCardResponseBasis(tx, {
    organizationId: seedData.organizationId,
    responseMessageId: response.id,
    sourceBasis: input.sourceBasis,
  })
  await tx.agentCard.update({ data: { responseMessageId: response.id }, where: { id: card.id } })
  return response.id
})

const withSeed = async (
  t: test.TestContext,
  run: (prisma: PrismaClient, seedData: Seed) => Promise<void>,
): Promise<void> => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { name: `card-basis-${suffix}` } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.$disconnect()
  })
  await run(prisma, await seed(prisma, suffix))
}

runDatabaseTest('a submitted personal-mail compose response inherits its card basis', async (t) => {
  await withSeed(t, async (prisma, seedData) => {
    const content = 'To: counsel@example.test · Subject: acquisition terms · Body: private terms'
    const responseId = await submitCardResponse(prisma, seedData, {
      content,
      sourceBasis: [{ scopeId: seedData.insiderId, scopeType: 'user' }],
    })
    const response = await prisma.message.findFirstOrThrow({
      where: { id: responseId },
      include: messageInclude,
    })
    const outsider = await mapMessageRecordWithAttachments(prisma, response, {
      channelId: seedData.channelId,
      organizationId: seedData.organizationId,
      userId: seedData.outsiderId,
    })
    assert.equal(outsider.restricted, true)
    assert.notEqual(outsider.content, content)
    assert.equal(JSON.stringify(outsider).includes('acquisition terms'), false)

    const insider = await mapMessageRecordWithAttachments(prisma, response, {
      channelId: seedData.channelId,
      organizationId: seedData.organizationId,
      userId: seedData.insiderId,
    })
    assert.equal(insider.content, content)
  })
})

runDatabaseTest('an unrestricted card response remains readable by the channel', async (t) => {
  await withSeed(t, async (prisma, seedData) => {
    const content = 'To: team@example.test · Subject: public update · Body: ready to send'
    const responseId = await submitCardResponse(prisma, seedData, { content, sourceBasis: [] })
    const response = await prisma.message.findFirstOrThrow({
      where: { id: responseId },
      include: messageInclude,
    })
    const outsider = await mapMessageRecordWithAttachments(prisma, response, {
      channelId: seedData.channelId,
      organizationId: seedData.organizationId,
      userId: seedData.outsiderId,
    })
    assert.equal(outsider.restricted, undefined)
    assert.equal(outsider.content, content)
  })
})
