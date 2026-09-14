import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { listUserAlerts } from '../src/services/alerts.js'
import { resolveChannelMentionAudience } from '../src/services/channel-mention-audience.js'
import { addMemberToChannel } from '../src/services/channel-members.js'
import { createThreadMessage } from '../src/services/message-create.js'

/**
 * Who an @mention can address (`docs/standards/user-alerts.md` → "Who a
 * mention can address").
 *
 * Against a real database because the guarantees are rows: which `UserAlert`
 * rows the message-create transaction writes, which of them
 * `visibleUserAlertWhere` lets surface, and which people the pre-send audience
 * read names as outsiders. A private channel's non-member must receive nothing
 * that carries the message; an open channel's non-member is addressable.
 */

const suite = 'c3e9'
const id = (n: string) => `00000000-0000-4000-8000-${suite}${n}`
const orgId = id('00000001')
const projectId = id('00000002')
const teamId = id('00000003')
const privateChannelId = id('00000004')
const publicChannelId = id('00000005')
const dmChannelId = id('00000006')
const privateThreadId = id('00000007')
const publicThreadId = id('00000008')

const authorId = id('00000010')
const memberId = id('00000011')
const outsiderId = id('00000012')
const deactivatedId = id('00000013')
const strangerId = id('00000014') // a principal with no membership of this organisation
const userIds = [authorId, memberId, outsiderId, deactivatedId, strangerId]

const dbTest = process.env.DATABASE_URL ? test : test.skip

const actorFor = (userId: string): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles: ['member'] },
  tenant: {
    organizationId: parseOrganizationId(orgId),
    projectId: parseProjectId(projectId),
    teamId: parseTeamId(teamId),
  },
  actionContext: { requestId: `req-mentions-${userId}`, teamId: parseTeamId(teamId) },
})

const seed = async (prisma: PrismaClient) => {
  await prisma.organization.create({ data: { id: orgId, name: `org-mentions-${suite}` } })
  await prisma.user.createMany({
    data: [
      { id: authorId, displayName: 'Ada Author' },
      { id: memberId, displayName: 'Mia Member' },
      { id: outsiderId, displayName: 'Otto Outsider' },
      { id: deactivatedId, displayName: 'Dora Gone' },
      { id: strangerId, displayName: 'Sam Stranger' },
    ].map((user, index) => ({ ...user, email: `org-mentions-${suite}-${index}@test.local` })),
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: orgId, userId: authorId },
      { organizationId: orgId, userId: memberId },
      { organizationId: orgId, userId: outsiderId },
      { deactivatedAt: new Date(), organizationId: orgId, userId: deactivatedId },
    ],
  })
  await prisma.project.create({ data: { id: projectId, name: `p-${suite}`, organizationId: orgId } })
  await prisma.team.create({ data: { id: teamId, name: `t-${suite}`, projectId } })
  const channelBase = { organizationId: orgId, projectId, teamId }
  await prisma.channel.create({
    data: { ...channelBase, id: privateChannelId, label: `priv-${suite}`, slug: `priv-${suite}`, visibility: 'private' },
  })
  await prisma.channel.create({
    data: { ...channelBase, id: publicChannelId, label: `pub-${suite}`, slug: `pub-${suite}`, visibility: 'public' },
  })
  await prisma.channel.create({
    data: {
      ...channelBase,
      dmKey: [orgId, teamId, ...[authorId, memberId].sort()].join(':'),
      id: dmChannelId,
      label: `dm-${suite}`,
      type: 'dm',
      visibility: 'private',
    },
  })
  await prisma.channelMember.createMany({
    data: [
      { channelId: privateChannelId, userId: authorId },
      { channelId: privateChannelId, userId: memberId },
      // Retained after deactivation: membership alone is never current access.
      { channelId: privateChannelId, userId: deactivatedId },
      { channelId: publicChannelId, userId: authorId },
      { channelId: dmChannelId, userId: authorId },
      { channelId: dmChannelId, userId: memberId },
    ],
  })
  await prisma.thread.createMany({
    data: [
      { channelId: privateChannelId, id: privateThreadId },
      { channelId: publicChannelId, id: publicThreadId },
    ],
  })
}

const cleanup = async (prisma: PrismaClient) => {
  await prisma.userAlert.deleteMany({ where: { organizationId: orgId } })
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } })
  await prisma.messageThreadFollow.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.message.deleteMany({ where: { thread: { channel: { organizationId: orgId } } } })
  await prisma.thread.deleteMany({ where: { channel: { organizationId: orgId } } })
  await prisma.channelMember.deleteMany({ where: { channel: { organizationId: orgId } } })
  await prisma.channel.deleteMany({ where: { organizationId: orgId } })
  await prisma.team.deleteMany({ where: { id: teamId } })
  await prisma.project.deleteMany({ where: { id: projectId } })
  await prisma.organizationMember.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
}

const withDb = async (run: (prisma: PrismaClient) => Promise<void>) => {
  const prisma = new PrismaClient()
  try {
    await cleanup(prisma)
    await seed(prisma)
    await run(prisma)
  } finally {
    await cleanup(prisma)
    await prisma.$disconnect()
  }
}

const mentionedUserIdsOf = (metadata: unknown): string[] =>
  ((metadata as { mentions?: { userIds?: string[] } } | null)?.mentions?.userIds ?? [])

const visibleAlerts = async (prisma: PrismaClient, userId: string) =>
  (await listUserAlerts(prisma, { organizationId: orgId, userId })).data

dbTest('a private channel non-member mentioned without an invite receives nothing', async () => {
  await withDb(async (prisma) => {
    const result = await createThreadMessage(prisma, {
      content: '@Otto Outsider and @Mia Member, the salary numbers are in',
      threadId: privateThreadId,
      userId: authorId,
    })
    assert.equal(result.kind, 'created')
    if (result.kind !== 'created') return

    // Not a mention: the push job is built from these ids, so nothing framed
    // as a mention — and no content snippet — can be queued for the outsider.
    assert.deepEqual(mentionedUserIdsOf(result.message.metadata), [memberId])
    assert.deepEqual(result.alertedUserIds, [memberId])
    assert.equal(await prisma.userAlert.count({ where: { userId: outsiderId } }), 0)
    assert.equal(
      await prisma.messageThreadFollow.count({ where: { userId: outsiderId } }),
      0,
      'a non-member does not follow a private thread',
    )
    assert.deepEqual(await visibleAlerts(prisma, outsiderId), [])
    assert.equal((await visibleAlerts(prisma, memberId)).length, 1)
  })
})

dbTest('a stray mention alert in a private channel never surfaces to a non-member', async () => {
  await withDb(async (prisma) => {
    const message = await prisma.message.create({
      data: { content: 'secret', role: 'user', threadId: privateThreadId, userId: authorId },
    })
    await prisma.userAlert.create({
      data: {
        channelId: privateChannelId,
        kind: 'mention',
        messageId: message.id,
        organizationId: orgId,
        threadId: privateThreadId,
        userId: outsiderId,
      },
    })
    assert.deepEqual(await visibleAlerts(prisma, outsiderId), [])
  })
})

dbTest('inviting the outsider first makes the same send a real mention', async () => {
  await withDb(async (prisma) => {
    const audience = await resolveChannelMentionAudience(prisma, actorFor(authorId), {
      channelId: privateChannelId,
      userIds: [outsiderId, memberId, deactivatedId, strangerId, authorId],
    })
    assert.deepEqual(audience, {
      kind: 'resolved',
      // The member already reads the room; a deactivated member and a person
      // outside the organisation are never addressable, so never named.
      audience: { outsiderUserIds: [outsiderId], viewerCanAddMembers: true },
    })

    assert.deepEqual(
      await addMemberToChannel(prisma, actorFor(authorId), {
        channelId: privateChannelId,
        userId: outsiderId,
      }),
      { kind: 'changed' },
    )
    const result = await createThreadMessage(prisma, {
      content: '@Otto Outsider welcome in',
      threadId: privateThreadId,
      userId: authorId,
    })
    assert.equal(result.kind, 'created')
    if (result.kind !== 'created') return
    assert.deepEqual(result.alertedUserIds, [outsiderId])
    assert.equal((await visibleAlerts(prisma, outsiderId)).length, 1)
  })
})

dbTest('anyone active in the organisation is addressable in a public channel', async () => {
  await withDb(async (prisma) => {
    const audience = await resolveChannelMentionAudience(prisma, actorFor(authorId), {
      channelId: publicChannelId,
      userIds: [outsiderId],
    })
    assert.deepEqual(audience, {
      kind: 'resolved',
      audience: { outsiderUserIds: [], viewerCanAddMembers: false },
    })

    const result = await createThreadMessage(prisma, {
      content: '@Otto Outsider @Dora Gone @Sam Stranger have a look',
      threadId: publicThreadId,
      userId: authorId,
    })
    assert.equal(result.kind, 'created')
    if (result.kind !== 'created') return
    assert.deepEqual(mentionedUserIdsOf(result.message.metadata), [outsiderId])
    assert.deepEqual(result.alertedUserIds, [outsiderId])
    const alerts = await visibleAlerts(prisma, outsiderId)
    assert.equal(alerts.length, 1, 'the bell shows a public-channel mention to a non-member')
    assert.equal(alerts[0]?.channelId, publicChannelId)
  })
})

dbTest('a DM prompts nobody and a reader outside a private channel learns nothing', async () => {
  await withDb(async (prisma) => {
    assert.deepEqual(
      await resolveChannelMentionAudience(prisma, actorFor(authorId), {
        channelId: dmChannelId,
        userIds: [outsiderId],
      }),
      { kind: 'resolved', audience: { outsiderUserIds: [], viewerCanAddMembers: false } },
    )
    assert.deepEqual(
      await resolveChannelMentionAudience(prisma, actorFor(outsiderId), {
        channelId: privateChannelId,
        userIds: [memberId],
      }),
      { kind: 'channel_not_found' },
    )
  })
})
