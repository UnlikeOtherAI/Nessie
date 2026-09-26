import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { parseOrganizationId, parseProjectId, parseTeamId,
  PERSON_MESSAGE_AUTHORSHIP, type AuthorizedActionContext } from '@nessie/schemas'

import { createThreadMessage } from '../src/services/message-create.js'
import { ChannelPostForbiddenError } from '../src/services/channel-posting-policy.js'
import { softDeleteMessage } from '../src/services/message-edit.js'
import {
  getConfirmationStatus,
  requestConfirmationReminders,
  updateConfirmationReceipt,
} from '../src/services/announcement-confirmations.js'
import { handleAnnouncementReminders } from '../../worker/src/control/announcement-reminders.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('read-only authority, frozen audience, confirmation and one reminder DM', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const projectId = randomUUID()
  const teamId = randomUUID()
  const channelId = randomUUID()
  const threadId = randomUUID()
  const adminId = randomUUID()
  const memberId = randomUUID()
  const outsiderId = randomUUID()
  const users = [adminId, memberId, outsiderId]
  const actor = (userId: string, role: string): AuthorizedActionContext => ({
    actor: { actorType: 'user', actorId: userId, roles: [role] },
    tenant: { organizationId: parseOrganizationId(organizationId),
      projectId: parseProjectId(projectId), teamId: parseTeamId(teamId) },
    actionContext: { requestId: randomUUID(), teamId: parseTeamId(teamId) },
  })
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'Announcement DB test' } })
    await prisma.user.createMany({ data: users.map((id, index) => ({
      id, email: `announcement-${organizationId}-${index}@test.local`,
      displayName: ['Admin', 'Member', 'Outsider'][index]!,
    })) })
    await prisma.organizationMember.createMany({ data: users.map((userId) => ({
      organizationId, userId, role: userId === adminId ? 'admin' : 'member',
    })) })
    await prisma.project.create({ data: { id: projectId, name: 'Announcement project', organizationId } })
    await prisma.team.create({ data: { id: teamId, projectId, name: 'Announcement team' } })
    await prisma.teamMember.createMany({ data: [adminId, memberId].map((userId) => ({
      teamId, userId, role: userId === adminId ? 'admin' : 'member',
    })) })
    await prisma.channel.create({ data: { id: channelId, organizationId,
      projectId, teamId, label: 'Announcements', slug: 'announcements', visibility: 'public',
      adminOnlyPosting: true, mandatoryAnnouncements: true,
      members: { create: [adminId, memberId].map((userId) => ({ userId })) },
    } })
    await prisma.thread.create({ data: { id: threadId, channelId, title: 'General' } })

    const privateChannelId = randomUUID()
    const privateThreadId = randomUUID()
    await prisma.channel.create({ data: { id: privateChannelId, organizationId,
      projectId, teamId, label: 'Private notices', slug: 'private-notices',
      visibility: 'private', adminOnlyPosting: true,
      members: { create: { userId: adminId } },
    } })
    await prisma.thread.create({ data: { id: privateThreadId,
      channelId: privateChannelId, title: 'General' } })
    await assert.rejects(createThreadMessage(prisma, {
      authorship: PERSON_MESSAGE_AUTHORSHIP,
      actorContext: actor(adminId, 'admin'),
      threadId: privateThreadId, userId: adminId,
      content: 'A private post cannot demand team-wide confirmation.',
      requiresConfirmation: true,
    }), ChannelPostForbiddenError)

    await assert.rejects(prisma.message.create({ data: {
      threadId, userId: memberId, role: 'user', content: 'Bypassed service',
    } }))
    await assert.rejects(createThreadMessage(prisma, {
      authorship: PERSON_MESSAGE_AUTHORSHIP,
      actorContext: actor(memberId, 'member'),
      threadId, userId: memberId, content: 'Cannot post',
    }), ChannelPostForbiddenError)
    assert.equal(await prisma.message.count({ where: { threadId } }), 0)

    const posted = await createThreadMessage(prisma, {
      authorship: PERSON_MESSAGE_AUTHORSHIP,
      actorContext: actor(adminId, 'admin'),
      threadId, userId: adminId, content: 'Please acknowledge this update.',
      requiresConfirmation: true, clientMessageId: randomUUID(),
    })
    assert.equal(posted.kind, 'created')
    if (posted.kind !== 'created') return
    assert.equal(posted.message.requiresConfirmation, true)
    assert.equal(posted.message.isAnnouncement, true)
    const receipts = await prisma.announcementDelivery.findMany({
      where: { messageId: posted.message.id },
    })
    assert.deepEqual(receipts.map((row) => row.recipientUserId), [memberId])
    const alerts = await prisma.userAlert.findMany({ where: { messageId: posted.message.id } })
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0]?.isAnnouncement, true)
    assert.equal(alerts[0]?.userId, memberId)
    assert.equal(await prisma.queueJob.count({ where: { idempotencyKey: `push:${posted.message.id}` } }), 1)
    assert.equal(await updateConfirmationReceipt(prisma, actor(outsiderId, 'member'),
      posted.message.id, 'acknowledge'), 'forbidden')
    await prisma.teamMember.create({ data: { teamId, userId: outsiderId, role: 'member' } })
    assert.equal(await updateConfirmationReceipt(prisma, actor(outsiderId, 'member'),
      posted.message.id, 'acknowledge'), 'forbidden')
    await prisma.teamMember.delete({ where: { teamId_userId: { teamId, userId: outsiderId } } })

    assert.equal(await updateConfirmationReceipt(prisma, actor(memberId, 'member'),
      posted.message.id, 'seen'), 'ok')
    const before = await getConfirmationStatus(prisma, actor(adminId, 'admin'), posted.message.id)
    assert.equal(before?.forbidden, false)
    if (!before || before.forbidden) return
    assert.equal(before.seen.length, 1)
    assert.equal(before.acknowledged.length, 0)
    assert.equal(await requestConfirmationReminders(prisma, actor(adminId, 'admin'),
      posted.message.id), 1)
    await handleAnnouncementReminders({ prisma, realtimeTransport: null }, {
      messageId: posted.message.id, senderUserId: adminId, organizationId,
    })
    const reminded = await prisma.announcementDelivery.findFirstOrThrow({
      where: { messageId: posted.message.id, recipientUserId: memberId },
    })
    assert.ok(reminded.reminderMessageId)
    const dmMessage = await prisma.message.findUniqueOrThrow({
      where: { id: reminded.reminderMessageId! },
    })
    assert.equal(dmMessage.userId, adminId)
    assert.equal(dmMessage.content,
      `[Go take a look at this](/channels/${channelId}/threads/${threadId}/replies/${posted.message.id})`)
    await handleAnnouncementReminders({ prisma, realtimeTransport: null }, {
      messageId: posted.message.id, senderUserId: adminId, organizationId,
    })
    assert.equal(await prisma.message.count({ where: { id: reminded.reminderMessageId! } }), 1)
    assert.equal(await updateConfirmationReceipt(prisma, actor(memberId, 'member'),
      posted.message.id, 'acknowledge'), 'ok')
    const after = await getConfirmationStatus(prisma, actor(adminId, 'admin'), posted.message.id)
    assert.equal(after?.forbidden, false)
    if (after && !after.forbidden) assert.equal(after.acknowledged.length, 1)

    const toCancel = await createThreadMessage(prisma, {
      authorship: PERSON_MESSAGE_AUTHORSHIP,
      actorContext: actor(adminId, 'admin'),
      threadId, userId: adminId, content: 'This announcement is cancelled.',
      requiresConfirmation: true, clientMessageId: randomUUID(),
    })
    assert.equal(toCancel.kind, 'created')
    if (toCancel.kind !== 'created') return
    assert.equal(await requestConfirmationReminders(prisma, actor(adminId, 'admin'),
      toCancel.message.id), 1)
    const cancelled = await softDeleteMessage(prisma, {
      messageId: toCancel.message.id, threadId, userId: adminId,
      actorContext: actor(adminId, 'admin'),
    })
    assert.equal(cancelled.kind, 'deleted')
    await handleAnnouncementReminders({ prisma, realtimeTransport: null }, {
      messageId: toCancel.message.id, senderUserId: adminId, organizationId,
    })
    const cancelledReceipt = await prisma.announcementDelivery.findFirstOrThrow({
      where: { messageId: toCancel.message.id },
    })
    assert.equal(cancelledReceipt.reminderMessageId, null)
    assert.equal(await prisma.auditLog.count({ where: {
      organizationId, action: 'announcement.cancelled', resourceId: toCancel.message.id,
    } }), 1)

    const toBlock = await createThreadMessage(prisma, {
      authorship: PERSON_MESSAGE_AUTHORSHIP,
      actorContext: actor(adminId, 'admin'),
      threadId, userId: adminId, content: 'Check channel participation.',
      requiresConfirmation: true, clientMessageId: randomUUID(),
    })
    assert.equal(toBlock.kind, 'created')
    if (toBlock.kind !== 'created') return
    assert.equal(await requestConfirmationReminders(prisma, actor(adminId, 'admin'),
      toBlock.message.id), 1)
    await prisma.channelMember.delete({ where: {
      channelId_userId: { channelId, userId: adminId },
    } })
    assert.equal(await requestConfirmationReminders(prisma, actor(adminId, 'admin'),
      toBlock.message.id), 'forbidden')
    await handleAnnouncementReminders({ prisma, realtimeTransport: null }, {
      messageId: toBlock.message.id, senderUserId: adminId, organizationId,
    })
    const blocked = await prisma.announcementDelivery.findFirstOrThrow({
      where: { messageId: toBlock.message.id },
    })
    assert.equal(blocked.reminderMessageId, null)
    assert.equal(blocked.reminderError, 'Sender can no longer remind from this channel')
    await prisma.channelMember.create({ data: { channelId, userId: adminId } })

    const toRetry = await createThreadMessage(prisma, {
      authorship: PERSON_MESSAGE_AUTHORSHIP,
      actorContext: actor(adminId, 'admin'),
      threadId, userId: adminId, content: 'Check current membership.',
      requiresConfirmation: true, clientMessageId: randomUUID(),
    })
    assert.equal(toRetry.kind, 'created')
    if (toRetry.kind !== 'created') return
    assert.equal(await requestConfirmationReminders(prisma, actor(adminId, 'admin'),
      toRetry.message.id), 1)
    await prisma.teamMember.delete({ where: { teamId_userId: { teamId, userId: memberId } } })
    await handleAnnouncementReminders({ prisma, realtimeTransport: null }, {
      messageId: toRetry.message.id, senderUserId: adminId, organizationId,
    })
    const ineligible = await prisma.announcementDelivery.findFirstOrThrow({
      where: { messageId: toRetry.message.id },
    })
    assert.equal(ineligible.reminderMessageId, null)
    assert.equal(ineligible.reminderError, 'Recipient is no longer in scope')
    await prisma.teamMember.create({ data: { teamId, userId: memberId, role: 'member' } })
    assert.equal(await requestConfirmationReminders(prisma, actor(adminId, 'admin'),
      toRetry.message.id), 1)
    await handleAnnouncementReminders({ prisma, realtimeTransport: null }, {
      messageId: toRetry.message.id, senderUserId: adminId, organizationId,
    })
    assert.ok((await prisma.announcementDelivery.findFirstOrThrow({
      where: { messageId: toRetry.message.id },
    })).reminderMessageId)

    // Mandatory notification is independent of read-only posting.
    await prisma.channel.update({ where: { id: channelId }, data: { adminOnlyPosting: false } })
    const memberPost = await createThreadMessage(prisma, {
      authorship: PERSON_MESSAGE_AUTHORSHIP,
      actorContext: actor(memberId, 'member'),
      threadId, userId: memberId, content: 'Normal discussion',
    })
    assert.equal(memberPost.kind, 'created')
    if (memberPost.kind !== 'created') return
    assert.equal(memberPost.message.isAnnouncement, false)
    assert.equal(await prisma.announcementDelivery.count({ where: {
      messageId: memberPost.message.id,
    } }), 0)
    const adminPost = await createThreadMessage(prisma, {
      authorship: PERSON_MESSAGE_AUTHORSHIP,
      actorContext: actor(adminId, 'admin'),
      threadId, userId: adminId, content: 'Mandatory but replies allowed',
    })
    assert.equal(adminPost.kind, 'created')
    if (adminPost.kind !== 'created') return
    assert.equal(adminPost.message.isAnnouncement, true)
    assert.equal(await prisma.announcementDelivery.count({ where: {
      messageId: adminPost.message.id,
    } }), 1)

    const rootProjectId = randomUUID()
    const rootTeamId = randomUUID()
    const rootChannelId = randomUUID()
    const rootThreadId = randomUUID()
    await prisma.project.create({ data: { id: rootProjectId, organizationId,
      channelRoot: true, name: 'Shared channels' } })
    await prisma.team.create({ data: { id: rootTeamId, projectId: rootProjectId,
      name: 'Shared channel root' } })
    await prisma.channel.create({ data: { id: rootChannelId, organizationId,
      projectId: rootProjectId, teamId: rootTeamId, label: 'Organisation notices',
      slug: 'organisation-notices', visibility: 'public',
      mandatoryAnnouncements: true,
      members: { create: { userId: adminId } },
    } })
    await prisma.thread.create({ data: { id: rootThreadId, channelId: rootChannelId,
      title: 'General' } })
    const organizationPost = await createThreadMessage(prisma, {
      authorship: PERSON_MESSAGE_AUTHORSHIP,
      actorContext: actor(adminId, 'admin'),
      threadId: rootThreadId, userId: adminId,
      content: 'Everyone in the organisation sees this.',
    })
    assert.equal(organizationPost.kind, 'created')
    if (organizationPost.kind !== 'created') return
    const organizationRecipients = await prisma.announcementDelivery.findMany({
      where: { messageId: organizationPost.message.id },
      select: { recipientUserId: true },
    })
    assert.deepEqual(organizationRecipients.map((row) => row.recipientUserId).sort(),
      [memberId, outsiderId].sort())
  } finally {
    await prisma.queueJob.deleteMany({ where: {
      payload: { path: ['organizationId'], equals: organizationId },
    } })
    await prisma.userAlert.deleteMany({ where: { organizationId } })
    await prisma.auditLog.deleteMany({ where: { organizationId } })
    await prisma.announcementDelivery.deleteMany({ where: { message: { thread: {
      channel: { organizationId },
    } } } })
    await prisma.message.deleteMany({ where: { thread: { channel: { organizationId } } } })
    await prisma.thread.deleteMany({ where: { channel: { organizationId } } })
    await prisma.channelMember.deleteMany({ where: { channel: { organizationId } } })
    await prisma.channel.deleteMany({ where: { organizationId } })
    await prisma.teamMember.deleteMany({ where: { team: { project: { organizationId } } } })
    await prisma.team.deleteMany({ where: { project: { organizationId } } })
    await prisma.project.deleteMany({ where: { organizationId } })
    await prisma.organizationMember.deleteMany({ where: { organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: users } } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.$disconnect()
  }
})
