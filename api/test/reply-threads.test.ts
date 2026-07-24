import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { unfollowReplyThread } from '@nessie/runtime'

import { createThreadMessage, listThreadMessages } from '../src/services/messages.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  organizationId: string
  projectId: string
  teamId: string
  channelId: string
  threadId: string
  threadBId: string
  rootAuthorId: string
  replyAuthorId: string
  mentionedUserId: string
}

const seedWorkspace = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `reply-threads ${randomUUID()}` } })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const makeUser = (displayName: string) =>
    prisma.user.create({
      data: { email: `reply-threads-${randomUUID()}@example.com`, displayName },
    })
  const rootAuthor = await makeUser('Root Author')
  const replyAuthor = await makeUser('Reply Author')
  const mentionedUser = await makeUser('Mentioned User')
  const channel = await prisma.channel.create({
    data: {
      label: 'c',
      slug: `c-${randomUUID()}`,
      organizationId: org.id,
      projectId: project.id,
      teamId: team.id,
      members: {
        create: [
          { userId: rootAuthor.id },
          { userId: replyAuthor.id },
          { userId: mentionedUser.id },
        ],
      },
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const threadB = await prisma.thread.create({ data: { channelId: channel.id } })
  return {
    organizationId: org.id,
    projectId: project.id,
    teamId: team.id,
    channelId: channel.id,
    threadId: thread.id,
    threadBId: threadB.id,
    rootAuthorId: rootAuthor.id,
    replyAuthorId: replyAuthor.id,
    mentionedUserId: mentionedUser.id,
  }
}

const cleanup = async (prisma: PrismaClient, seed: Seed) => {
  await prisma.message.deleteMany({
    where: { threadId: { in: [seed.threadId, seed.threadBId] } },
  })
  await prisma.thread.deleteMany({ where: { channelId: seed.channelId } })
  await prisma.channel.deleteMany({ where: { id: seed.channelId } })
  await prisma.user.deleteMany({
    where: {
      id: { in: [seed.rootAuthorId, seed.replyAuthorId, seed.mentionedUserId] },
    },
  })
  await prisma.team.deleteMany({ where: { id: seed.teamId } })
  await prisma.project.deleteMany({ where: { id: seed.projectId } })
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
}

const createRoot = async (prisma: PrismaClient, seed: Seed, content = 'root post') => {
  const result = await createThreadMessage(prisma, {
    content,
    threadId: seed.threadId,
    userId: seed.rootAuthorId,
  })
  assert.equal(result.kind, 'created')
  if (result.kind !== 'created') throw new Error('unreachable')
  return result.message
}

const createReply = async (
  prisma: PrismaClient,
  seed: Seed,
  input: { rootMessageId: string; userId: string; content?: string; threadId?: string },
) =>
  createThreadMessage(prisma, {
    content: input.content ?? 'a reply',
    threadId: input.threadId ?? seed.threadId,
    userId: input.userId,
    rootMessageId: input.rootMessageId,
  })

const followExists = async (
  prisma: PrismaClient,
  rootMessageId: string,
  userId: string,
): Promise<boolean> =>
  (await prisma.messageThreadFollow.findUnique({
    where: { rootMessageId_userId: { rootMessageId, userId } },
    select: { rootMessageId: true },
  })) !== null

runDatabaseTest('replies attach to the root and the default feed lists top-level posts only', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const root = await createRoot(prisma, seed)
  const reply = await createReply(prisma, seed, {
    rootMessageId: root.id,
    userId: seed.replyAuthorId,
  })
  assert.equal(reply.kind, 'created')
  if (reply.kind !== 'created') return
  assert.equal(reply.message.rootMessageId, root.id)
  assert.equal(reply.replyRoot?.rootMessageId, root.id)
  assert.equal(reply.replyRoot?.metadata.replyCount, 1)
  assert.deepEqual(reply.replyRoot?.metadata.replyParticipantIds, [seed.replyAuthorId])

  // Default feed: the root only, replies excluded.
  const topLevel = await listThreadMessages(prisma, seed.threadId)
  assert.deepEqual(
    topLevel.data.map((m) => m.id),
    [root.id],
  )
  assert.equal(topLevel.data[0]?.replyCount, 1)
  assert.ok(topLevel.data[0]?.lastReplyAt)
  assert.deepEqual(topLevel.data[0]?.replyParticipantIds, [seed.replyAuthorId])

  // Replies feed under the root.
  const replies = await listThreadMessages(prisma, seed.threadId, {
    rootMessageId: root.id,
  })
  assert.deepEqual(
    replies.data.map((m) => m.id),
    [reply.message.id],
  )
  assert.equal(replies.data[0]?.rootMessageId, root.id)
})

runDatabaseTest('replies feed paginates with the same keyset cursor', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const root = await createRoot(prisma, seed)
  const first = await createReply(prisma, seed, {
    rootMessageId: root.id,
    userId: seed.replyAuthorId,
    content: 'first reply',
  })
  const second = await createReply(prisma, seed, {
    rootMessageId: root.id,
    userId: seed.rootAuthorId,
    content: 'second reply',
  })
  assert.equal(first.kind, 'created')
  assert.equal(second.kind, 'created')
  if (first.kind !== 'created' || second.kind !== 'created') return

  const newest = await listThreadMessages(prisma, seed.threadId, {
    rootMessageId: root.id,
    limit: 1,
  })
  assert.equal(newest.data.length, 1)
  assert.equal(newest.data[0]?.id, second.message.id)
  assert.equal(newest.meta.hasMore, true)
  assert.ok(newest.meta.cursor)

  const older = await listThreadMessages(prisma, seed.threadId, {
    rootMessageId: root.id,
    limit: 1,
    before: newest.meta.cursor ?? undefined,
  })
  assert.equal(older.data.length, 1)
  assert.equal(older.data[0]?.id, first.message.id)
  assert.equal(older.meta.hasMore, false)
})

runDatabaseTest('one level deep: a reply cannot be used as a root', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const root = await createRoot(prisma, seed)
  const reply = await createReply(prisma, seed, {
    rootMessageId: root.id,
    userId: seed.replyAuthorId,
  })
  assert.equal(reply.kind, 'created')
  if (reply.kind !== 'created') return

  const nested = await createReply(prisma, seed, {
    rootMessageId: reply.message.id,
    userId: seed.rootAuthorId,
  })
  assert.equal(nested.kind, 'invalid_root')
})

runDatabaseTest('a root from another container thread is rejected', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const root = await createRoot(prisma, seed)
  const cross = await createReply(prisma, seed, {
    rootMessageId: root.id,
    userId: seed.replyAuthorId,
    threadId: seed.threadBId,
  })
  assert.equal(cross.kind, 'invalid_root')

  // Nothing was created in thread B.
  const feedB = await listThreadMessages(prisma, seed.threadBId)
  assert.equal(feedB.data.length, 0)
})

runDatabaseTest('materialized reply metadata stays exact under concurrent replies', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const root = await createRoot(prisma, seed)
  const authors = [seed.rootAuthorId, seed.replyAuthorId, seed.mentionedUserId]
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      createReply(prisma, seed, {
        rootMessageId: root.id,
        userId: authors[index % authors.length]!,
        content: `concurrent reply ${index}`,
      })),
  )
  for (const result of results) {
    assert.equal(result.kind, 'created')
  }
  const createdAts = results.map((r) =>
    r.kind === 'created' ? r.message.createdAt.getTime() : 0,
  )

  const fresh = await prisma.message.findUnique({ where: { id: root.id } })
  assert.equal(fresh?.replyCount, 8)
  assert.equal(fresh?.lastReplyAt?.getTime(), Math.max(...createdAts))
  assert.equal(fresh?.replyParticipantIds.length, 3)
  for (const authorId of authors) {
    assert.ok(fresh?.replyParticipantIds.includes(authorId))
  }
})

runDatabaseTest('follow lifecycle: authors + mentioned users follow, unfollow sticks unless they participate', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  // Root author auto-follows on create.
  const root = await createRoot(prisma, seed)
  assert.equal(await followExists(prisma, root.id, seed.rootAuthorId), true)

  // Reply author + mentioned user follow on reply.
  const reply = await createReply(prisma, seed, {
    rootMessageId: root.id,
    userId: seed.replyAuthorId,
    content: 'ping @Mentioned User!',
  })
  assert.equal(reply.kind, 'created')
  assert.equal(await followExists(prisma, root.id, seed.replyAuthorId), true)
  assert.equal(await followExists(prisma, root.id, seed.mentionedUserId), true)

  // After an explicit unfollow, someone else's plain reply does not re-add them.
  await unfollowReplyThread(prisma, {
    rootMessageId: root.id,
    userId: seed.mentionedUserId,
  })
  assert.equal(await followExists(prisma, root.id, seed.mentionedUserId), false)
  const plain = await createReply(prisma, seed, {
    rootMessageId: root.id,
    userId: seed.replyAuthorId,
    content: 'no mention here',
  })
  assert.equal(plain.kind, 'created')
  assert.equal(await followExists(prisma, root.id, seed.mentionedUserId), false)

  // But the unfollowed user participating again re-follows.
  const rejoin = await createReply(prisma, seed, {
    rootMessageId: root.id,
    userId: seed.mentionedUserId,
    content: 'I am back',
  })
  assert.equal(rejoin.kind, 'created')
  assert.equal(await followExists(prisma, root.id, seed.mentionedUserId), true)
})
