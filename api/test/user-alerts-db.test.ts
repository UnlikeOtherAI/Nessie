import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { listUserAlerts, markUserAlertsRead } from '../src/services/alerts.js'
import { createThreadMessage } from '../src/services/message-create.js'

// DB-backed coverage for the user_alerts migration (#246): real FKs, the real
// message-create transaction, and the real list/read queries (including the
// channel/actor relation hydration the in-memory stores cannot exercise).
// Runs only when DATABASE_URL points at a live database.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  organizationId: string
  channelId: string
  threadId: string
  authorId: string
  mentionedId: string
}

const seedWorkspace = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `alerts ${randomUUID()}` } })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const author = await prisma.user.create({
    data: { email: `alerts-author-${randomUUID()}@example.com`, displayName: 'Author One' },
  })
  const mentioned = await prisma.user.create({
    data: { email: `alerts-mentioned-${randomUUID()}@example.com`, displayName: 'Mentioned One' },
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: org.id, userId: author.id },
      { organizationId: org.id, userId: mentioned.id },
    ],
  })
  const channel = await prisma.channel.create({
    data: {
      label: 'alerts-channel',
      slug: `alerts-${randomUUID()}`,
      organizationId: org.id,
      projectId: project.id,
      teamId: team.id,
      members: { create: [{ userId: author.id }, { userId: mentioned.id }] },
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  return {
    organizationId: org.id,
    channelId: channel.id,
    threadId: thread.id,
    authorId: author.id,
    mentionedId: mentioned.id,
  }
}

const cleanup = async (prisma: PrismaClient, seed: Seed) => {
  // The organization delete cascades to channels/threads/messages/user_alerts.
  await prisma.organization.delete({ where: { id: seed.organizationId } }).catch(() => undefined)
  await prisma.user.deleteMany({ where: { id: { in: [seed.authorId, seed.mentionedId] } } })
}

runDatabaseTest('mention alerts persist in the message-create transaction and drive list/read', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(() => cleanup(prisma, seed).then(() => prisma.$disconnect()))

  // A direct mention (plus a self-mention and a broadcast, which must NOT
  // create rows) commits the alert atomically with the message.
  const result = await createThreadMessage(prisma, {
    content: '@Mentioned One @Author One @channel heads up',
    threadId: seed.threadId,
    userId: seed.authorId,
  })
  assert.equal(result.kind, 'created')
  if (result.kind !== 'created') return
  assert.deepEqual(result.alertedUserIds, [seed.mentionedId])

  const rows = await prisma.userAlert.findMany({
    where: { organizationId: seed.organizationId },
  })
  assert.equal(rows.length, 1)
  const row = rows[0]!
  assert.equal(row.userId, seed.mentionedId)
  assert.equal(row.kind, 'mention')
  assert.equal(row.messageId, result.message.id)
  assert.equal(row.threadId, seed.threadId)
  assert.equal(row.channelId, seed.channelId)
  assert.equal(row.actorUserId, seed.authorId)
  assert.equal(row.actorAgentId, null)
  assert.equal(row.readAt, null)

  // The list hydrates channel + actor display names for bell/dropdown rendering.
  const list = await listUserAlerts(prisma, {
    organizationId: seed.organizationId,
    userId: seed.mentionedId,
  })
  assert.equal(list.data.unreadCount, 1)
  assert.equal(list.data.alerts.length, 1)
  assert.equal(list.data.alerts[0]?.channelLabel, 'alerts-channel')
  assert.equal(list.data.alerts[0]?.actorDisplayName, 'Author One')

  // The author sees no alert for their own message.
  const authorList = await listUserAlerts(prisma, {
    organizationId: seed.organizationId,
    userId: seed.authorId,
  })
  assert.equal(authorList.data.alerts.length, 0)
  assert.equal(authorList.data.unreadCount, 0)

  // Marking read persists readAt and zeroes the unread count.
  const marked = await markUserAlertsRead(prisma, {
    organizationId: seed.organizationId,
    userId: seed.mentionedId,
    all: true,
  })
  assert.equal(marked.read, 1)
  assert.equal(marked.unreadCount, 0)
  const reread = await prisma.userAlert.findUniqueOrThrow({ where: { id: row.id } })
  assert.ok(reread.readAt instanceof Date)
})
