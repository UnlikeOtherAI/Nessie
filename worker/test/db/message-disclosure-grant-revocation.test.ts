import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import {
  canUserReadDisclosureBasis,
  grantMessageDisclosure,
} from '@nessie/runtime'

import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import { runMessageEditTool } from '../../src/run/pa-tools/agent-messages.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'

type Seed = {
  agentId: string
  authorId: string
  channelId: string
  messageId: string
  organizationId: string
  recipientId: string
  sourceChannelId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: { name: `message-grant-revocation-${suffix}` },
  })
  const [author, recipient] = await Promise.all([
    prisma.user.create({ data: { displayName: 'Source author', email: `author-${suffix}@example.test` } }),
    prisma.user.create({ data: { displayName: 'Grant recipient', email: `recipient-${suffix}@example.test` } }),
  ])
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, role: 'member', userId: author.id },
      { organizationId: organization.id, role: 'member', userId: recipient.id },
    ],
  })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const [channel, sourceChannel] = await Promise.all([
    prisma.channel.create({
      data: {
        label: `public-${suffix}`,
        organizationId: organization.id,
        projectId: project.id,
        slug: `public-${suffix.slice(0, 8)}`,
        teamId: team.id,
        type: 'standard',
        visibility: 'public',
      },
    }),
    prisma.channel.create({
      data: {
        label: `private-${suffix}`,
        organizationId: organization.id,
        projectId: project.id,
        slug: `private-${suffix.slice(0, 8)}`,
        teamId: team.id,
        type: 'standard',
        visibility: 'private',
      },
    }),
  ])
  await prisma.channelMember.create({ data: { channelId: sourceChannel.id, userId: author.id } })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({
    data: {
      agentKind: 'shared',
      name: `agent-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const message = await prisma.message.create({
    data: {
      agentId: agent.id,
      content: 'B-OLD-PRIVATE-REPLY',
      onBehalfOfUserId: author.id,
      role: 'assistant',
      threadId: thread.id,
    },
  })
  await prisma.messageBasisScope.create({
    data: {
      messageId: message.id,
      organizationId: organization.id,
      scopeId: sourceChannel.id,
      scopeType: 'channel',
    },
  })
  await prisma.messageDisclosureSource.create({
    data: {
      messageId: message.id,
      organizationId: organization.id,
      sourceAuthorUserId: author.id,
      sourceChannelId: sourceChannel.id,
    },
  })
  return {
    agentId: agent.id,
    authorId: author.id,
    channelId: channel.id,
    messageId: message.id,
    organizationId: organization.id,
    recipientId: recipient.id,
    sourceChannelId: sourceChannel.id,
  }
}

const contextFor = (prisma: PrismaClient, seed: Seed): BuiltinToolRuntimeContext => {
  const consumedSources = createConsumedSourceSink()
  consumedSources.addPrivateConversationSource({
    sourceAuthorUserId: seed.authorId,
    sourceChannelId: seed.sourceChannelId,
  })
  return {
    agentId: seed.agentId,
    channel: { id: seed.channelId, organizationId: seed.organizationId, systemChannelType: null },
    consumedSources,
    prisma,
    run: {
      id: randomUUID(),
      messageId: randomUUID(),
      principalUserId: seed.authorId,
      threadId: randomUUID(),
    },
  } as BuiltinToolRuntimeContext
}

const recipientCanRead = (prisma: PrismaClient, seed: Seed): Promise<boolean> =>
  canUserReadDisclosureBasis(prisma, {
    agentId: seed.agentId,
    basis: [{ scopeId: seed.sourceChannelId, scopeType: 'channel' }],
    channelId: seed.channelId,
    disclosureSources: [{ sourceAuthorUserId: seed.authorId, sourceChannelId: seed.sourceChannelId }],
    messageId: seed.messageId,
    organizationId: seed.organizationId,
    userId: seed.recipientId,
  })

runDatabaseTest('message_edit revokes a grant before its replacement private body is readable', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: s.organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [s.authorId, s.recipientId] } } })
    await prisma.$disconnect()
  })

  const grant = await grantMessageDisclosure(prisma, {
    audienceId: s.recipientId,
    audienceKind: 'user',
    expectedContent: 'B-OLD-PRIVATE-REPLY',
    messageId: s.messageId,
    organizationId: s.organizationId,
    userId: s.authorId,
  })
  assert.equal(await recipientCanRead(prisma, s), true)

  await runMessageEditTool(contextFor(prisma, s), {
    content: 'B-NEW-PRIVATE-CANARY',
    messageId: s.messageId,
  })

  const [message, storedGrant, sources] = await Promise.all([
    prisma.message.findUniqueOrThrow({ where: { id: s.messageId }, select: { content: true } }),
    prisma.disclosureGrant.findUniqueOrThrow({ where: { id: grant.id } }),
    prisma.messageDisclosureSource.findMany({
      where: { messageId: s.messageId },
      select: { sourceAuthorUserId: true, sourceChannelId: true },
    }),
  ])
  assert.equal(message.content, 'B-NEW-PRIVATE-CANARY')
  assert.ok(storedGrant.revokedAt)
  assert.equal(await recipientCanRead(prisma, s), false)
  assert.deepEqual(sources, [{ sourceAuthorUserId: s.authorId, sourceChannelId: s.sourceChannelId }])
})