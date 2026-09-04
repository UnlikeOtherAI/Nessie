import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { getAttentionSummary, listUserAlerts, markUserAlertsRead } from '../src/services/alerts.js'
import { createThreadMessage } from '../src/services/message-create.js'

// DB-backed coverage for the user_alerts migration (#246): real FKs, the real
// message-create transaction, and the real list/read queries (including the
// channel/actor relation hydration the in-memory stores cannot exercise).
// Runs only when DATABASE_URL points at a live database.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  organizationId: string
  teamId: string
  channelId: string
  threadId: string
  authorId: string
  mentionedId: string
}

const seedTeam = async (prisma: PrismaClient): Promise<Seed> => {
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
    teamId: team.id,
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
  const seed = await seedTeam(prisma)
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
  assert.equal(list.data.length, 1)
  // The unread count is the attention summary's fact, not a field inside the
  // page — the list route answers the shared paged-list contract.
  const summary = await getAttentionSummary(prisma, {
    organizationId: seed.organizationId,
    userId: seed.mentionedId,
  })
  assert.equal(summary.unreadCount, 1)
  assert.equal(list.data[0]?.channelLabel, 'alerts-channel')
  assert.equal(list.data[0]?.actorDisplayName, 'Author One')

  // The author sees no alert for their own message.
  const authorList = await listUserAlerts(prisma, {
    organizationId: seed.organizationId,
    userId: seed.authorId,
  })
  assert.equal(authorList.data.length, 0)
  const authorSummary = await getAttentionSummary(prisma, {
    organizationId: seed.organizationId,
    userId: seed.authorId,
  })
  assert.equal(authorSummary.unreadCount, 0)

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

runDatabaseTest('mailbox-health alerts expose only their personal or shared owning surface', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedTeam(prisma)
  t.after(() => cleanup(prisma, seed).then(() => prisma.$disconnect()))

  const [personal, shared] = await Promise.all([
    prisma.mailboxConnection.create({
      data: {
        address: `personal-${randomUUID()}@example.test`,
        createdByUserId: seed.mentionedId,
        imapHost: 'imap.example.test',
        imapPort: 993,
        imapSecurity: 'tls',
        label: 'Personal',
        organizationId: seed.organizationId,
        ownerUserId: seed.mentionedId,
        smtpHost: 'smtp.example.test',
        smtpPort: 587,
        smtpSecurity: 'starttls',
        status: 'needs_reauthorization',
        username: 'personal',
      },
    }),
    prisma.mailboxConnection.create({
      data: {
        address: `shared-${randomUUID()}@example.test`,
        createdByUserId: seed.authorId,
        imapHost: 'imap.example.test',
        imapPort: 993,
        imapSecurity: 'tls',
        label: 'Shared',
        organizationId: seed.organizationId,
        smtpHost: 'smtp.example.test',
        smtpPort: 587,
        smtpSecurity: 'starttls',
        status: 'needs_reauthorization',
        teamId: seed.teamId,
        username: 'shared',
      },
    }),
  ])
  await prisma.userAlert.createMany({
    data: [
      {
        eventKey: `mailbox-health:${personal.id}:1`,
        kind: 'mailbox_connection_health',
        mailboxConnectionId: personal.id,
        organizationId: seed.organizationId,
        userId: seed.mentionedId,
      },
      {
        eventKey: `mailbox-health:${shared.id}:1`,
        kind: 'mailbox_connection_health',
        mailboxConnectionId: shared.id,
        organizationId: seed.organizationId,
        userId: seed.mentionedId,
      },
    ],
  })

  const list = await listUserAlerts(prisma, {
    organizationId: seed.organizationId,
    userId: seed.mentionedId,
  })
  const scopes = new Map(list.data.map((alert) => [alert.mailboxConnectionId, alert.mailboxScope]))
  assert.equal(scopes.get(personal.id), 'user')
  assert.equal(scopes.get(shared.id), 'team')
})
