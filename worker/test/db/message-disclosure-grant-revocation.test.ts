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

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve: (() => void) | undefined
  return {
    promise: new Promise<void>((done) => { resolve = done }),
    resolve: () => resolve?.(),
  }
}

const grantFor = (prisma: PrismaClient, seed: Seed, expectedContent: string) =>
  grantMessageDisclosure(prisma, {
    audienceId: seed.recipientId,
    audienceKind: 'user',
    expectedContent,
    messageId: seed.messageId,
    organizationId: seed.organizationId,
    userId: seed.authorId,
  })

runDatabaseTest('message_edit revokes a grant before its replacement private body is readable', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: s.organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [s.authorId, s.recipientId] } } })
    await prisma.$disconnect()
  })

  const grant = await grantFor(prisma, s, 'B-OLD-PRIVATE-REPLY')
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

runDatabaseTest('message grants bind the reviewed body and preserve approvals for identical updates', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: s.organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [s.authorId, s.recipientId] } } })
    await prisma.$disconnect()
  })

  const original = await grantFor(prisma, s, 'B-OLD-PRIVATE-REPLY')
  await prisma.message.update({
    where: { id: s.messageId },
    data: { content: 'B-OLD-PRIVATE-REPLY' },
  })
  assert.equal((await prisma.disclosureGrant.findUniqueOrThrow({ where: { id: original.id } })).revokedAt, null)
  assert.equal(await recipientCanRead(prisma, s), true)

  await prisma.message.update({
    where: { id: s.messageId },
    data: { content: 'B-CURRENT-PRIVATE-REPLY' },
  })
  await assert.rejects(
    grantFor(prisma, s, 'B-OLD-PRIVATE-REPLY'),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'DISCLOSURE_CONTENT_CHANGED',
  )
  assert.equal(await recipientCanRead(prisma, s), false)

  const renewed = await grantFor(prisma, s, 'B-CURRENT-PRIVATE-REPLY')
  assert.equal(renewed.id, original.id)
  assert.equal((await prisma.disclosureGrant.findUniqueOrThrow({ where: { id: original.id } })).revokedAt, null)
  assert.equal(await recipientCanRead(prisma, s), true)
})

runDatabaseTest('grant and content-change ordering cannot leave an approval on an older body', async (t) => {
  const prisma = new PrismaClient()
  const grantClient = new PrismaClient()
  const editClient = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: s.organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [s.authorId, s.recipientId] } } })
    await Promise.all([prisma.$disconnect(), grantClient.$disconnect(), editClient.$disconnect()])
  })

  const original = await grantFor(prisma, s, 'B-OLD-PRIVATE-REPLY')
  const renewalReachedUpsert = deferred()
  const releaseRenewal = deferred()
  const interceptedGrantClient = grantClient.$extends({
    query: {
      disclosureGrant: {
        upsert: async ({ args, query }) => {
          // `grantMessageDisclosure` reaches this only after acquiring its
          // advisory lock and checking the exact body. Pause there so the
          // content update demonstrably queues behind the canonical lock.
          renewalReachedUpsert.resolve()
          await releaseRenewal.promise
          return query(args)
        },
      },
    },
  })
  const renewal = grantFor(interceptedGrantClient as PrismaClient, s, 'B-OLD-PRIVATE-REPLY')
  await renewalReachedUpsert.promise
  const replacement = editClient.message.update({
    where: { id: s.messageId },
    data: { content: 'B-REPLACED-AFTER-GRANT' },
  })
  releaseRenewal.resolve()
  await Promise.all([renewal, replacement])

  const afterGrantFirst = await prisma.disclosureGrant.findUniqueOrThrow({ where: { id: original.id } })
  assert.ok(afterGrantFirst.revokedAt)
  assert.equal(await recipientCanRead(prisma, s), false)

  const lockHeld = deferred()
  const releaseContentChange = deferred()
  const contentChange = editClient.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(
      hashtextextended(${`disclosure-message:${s.messageId}`}::text, 0)
    )`
    lockHeld.resolve()
    await releaseContentChange.promise
    await tx.message.update({
      where: { id: s.messageId },
      data: { content: 'B-REPLACED-BEFORE-GRANT' },
    })
  })
  await lockHeld.promise
  // Attach the rejection handler before releasing the transaction so Node
  // cannot report a rejected promise before the assertion observes it.
  const staleRenewal = grantFor(grantClient, s, 'B-REPLACED-AFTER-GRANT').then(
    () => null,
    (error: unknown) => error,
  )
  releaseContentChange.resolve()
  await contentChange
  const staleError = await staleRenewal
  assert.ok(staleError instanceof Error && 'code' in staleError)
  assert.equal(staleError.code, 'DISCLOSURE_CONTENT_CHANGED')
  assert.equal(await recipientCanRead(prisma, s), false)
})
