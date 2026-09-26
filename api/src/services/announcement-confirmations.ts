import type { PrismaClient } from '@prisma/client'
import { resolveLiveEntitlementDecision } from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { enqueueQueueJob, writeAuditEntryInTransaction } from '@nessie/db'
import { randomUUID } from 'node:crypto'

import { listAnnouncementRecipients } from './announcement-audience.js'
import { canAdminPostInChannel } from './channel-posting-policy.js'
import { findThreadForUser } from './message-read-state.js'

export class AnnouncementAccessUnavailableError extends Error {}

const loadConfirmation = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  messageId: string,
) => {
  const message = await prisma.message.findFirst({
    where: { id: messageId, requiresConfirmation: true, rootMessageId: null,
      thread: { channel: { organizationId: actorContext.tenant.organizationId } },
    },
    select: {
      id: true, userId: true, threadId: true, deletedAt: true,
      thread: { select: { channel: { select: {
        id: true, organizationId: true, teamId: true, type: true,
        systemChannelType: true, project: { select: { channelRoot: true } },
        organization: { select: { externalOrgId: true } },
        team: { select: { externalTeamId: true } },
      } } } },
    },
  })
  if (!message) return null
  const reader = await findThreadForUser(
    prisma, message.threadId, actorContext.actor.actorId,
    actorContext.tenant.organizationId,
  )
  return reader ? message : null
}

const currentAudienceMember = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  channel: NonNullable<Awaited<ReturnType<typeof loadConfirmation>>>['thread']['channel'],
): Promise<boolean> => {
  const userId = actorContext.actor.actorId
  const decision = await resolveLiveEntitlementDecision(prisma, {
    organizationId: channel.organizationId,
    userId,
    ...(actorContext.actionContext.uoaIdentity
      ? { uoaIdentity: actorContext.actionContext.uoaIdentity } : {}),
  })
  if (decision.status === 'unavailable') throw new AnnouncementAccessUnavailableError()
  if (decision.status !== 'allowed') return false
  if (channel.project.channelRoot) return true
  if (decision.entitlements.kind === 'uoa') {
    return decision.entitlements.teamIds.includes(channel.teamId)
  }
  return (await prisma.teamMember.count({ where: { teamId: channel.teamId, userId } })) > 0
}

/** One exact post is observed; the thread's broad read cursor is never used. */
export const updateConfirmationReceipt = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  messageId: string,
  action: 'seen' | 'acknowledge',
): Promise<'ok' | 'not_found' | 'forbidden'> => {
  const message = await loadConfirmation(prisma, actorContext, messageId)
  if (!message || message.deletedAt) return 'not_found'
  if (!(await currentAudienceMember(prisma, actorContext, message.thread.channel))) return 'forbidden'
  const recipient = message.thread.channel.organization.externalOrgId
    ? { recipientUoaSub: actorContext.actionContext.uoaIdentity?.subject ?? '' }
    : { recipientUserId: actorContext.actor.actorId }
  const receipt = await prisma.announcementDelivery.findFirst({
    where: { messageId, ...recipient }, select: { id: true },
  })
  if (!receipt) return 'forbidden'
  if (action === 'acknowledge') {
    await prisma.announcementDelivery.updateMany({
      where: { id: receipt.id, acknowledgedAt: null },
      data: { acknowledgedAt: new Date(), seenAt: new Date() },
    })
  } else {
    await prisma.announcementDelivery.updateMany({
      where: { id: receipt.id, seenAt: null }, data: { seenAt: new Date() },
    })
  }
  return 'ok'
}

export const getOwnConfirmationReceipt = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  messageId: string,
) => {
  const message = await loadConfirmation(prisma, actorContext, messageId)
  if (!message || message.deletedAt) return null
  if (!(await currentAudienceMember(prisma, actorContext, message.thread.channel))) {
    return { eligible: false, seen: false, acknowledged: false }
  }
  const recipient = message.thread.channel.organization.externalOrgId
    ? { recipientUoaSub: actorContext.actionContext.uoaIdentity?.subject ?? '' }
    : { recipientUserId: actorContext.actor.actorId }
  const receipt = await prisma.announcementDelivery.findFirst({
    where: { messageId, ...recipient },
    select: { seenAt: true, acknowledgedAt: true },
  })
  return { eligible: receipt !== null, seen: Boolean(receipt?.seenAt),
    acknowledged: Boolean(receipt?.acknowledgedAt) }
}

export const getConfirmationStatus = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  messageId: string,
) => {
  const message = await loadConfirmation(prisma, actorContext, messageId)
  if (!message) return null
  const isAuthor = message.userId === actorContext.actor.actorId
  const isAdmin = await canAdminPostInChannel(
    prisma, message.thread.channel, actorContext.actor.actorId, actorContext,
  )
  const participates = isAuthor && isAdmin && Boolean(await prisma.channelMember.count({
    where: { channelId: message.thread.channel.id, userId: actorContext.actor.actorId },
  }))
  if (!isAuthor && !isAdmin) return { forbidden: true as const }
  const recipients = await listAnnouncementRecipients(
    prisma, message.thread.channel, actorContext, message.userId ?? '',
  )
  const receiptRows = await prisma.announcementDelivery.findMany({
    where: { messageId },
    select: { recipientUoaSub: true, recipientUserId: true, seenAt: true,
      acknowledgedAt: true, reminderMessageId: true, reminderError: true,
      reminderClaimedAt: true,
    },
  })
  const receiptByKey = new Map(receiptRows.map((receipt) => [
    receipt.recipientUoaSub ?? receipt.recipientUserId, receipt,
  ]))
  const people = recipients.flatMap((recipient) => {
    const key = 'recipientUoaSub' in recipient
      ? recipient.recipientUoaSub : recipient.recipientUserId
    const receipt = receiptByKey.get(key)
    if (!receipt) return []
    return [{
      id: key,
      displayName: recipient.displayName ?? 'Member',
      seenAt: receipt.seenAt?.toISOString() ?? null,
      acknowledgedAt: receipt.acknowledgedAt?.toISOString() ?? null,
      reminderSent: receipt.reminderMessageId !== null,
      reminderPending: receipt.reminderClaimedAt !== null
        && receipt.reminderMessageId === null && receipt.reminderError === null,
      reminderError: receipt.reminderError,
    }]
  })
  return {
    forbidden: false as const,
    canRemind: participates && message.deletedAt === null,
    acknowledged: people.filter((person) => person.acknowledgedAt),
    seen: people.filter((person) => person.seenAt && !person.acknowledgedAt),
    unseen: people.filter((person) => !person.seenAt),
  }
}

/** The click is the authority for one durable, manually requested fanout. */
export const requestConfirmationReminders = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  messageId: string,
): Promise<number | 'forbidden' | 'not_found'> => {
  const message = await loadConfirmation(prisma, actorContext, messageId)
  if (!message || message.deletedAt) return 'not_found'
  if (message.userId !== actorContext.actor.actorId || !(await canAdminPostInChannel(
    prisma, message.thread.channel, actorContext.actor.actorId, actorContext,
  ))) return 'forbidden'
  if (!(await prisma.channelMember.count({ where: {
    channelId: message.thread.channel.id, userId: actorContext.actor.actorId,
  } }))) return 'forbidden'
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.announcementDelivery.updateMany({
      where: { messageId, acknowledgedAt: null, reminderClaimedAt: null },
      data: { reminderClaimedAt: new Date() },
    })
    const failed = await tx.announcementDelivery.count({
      where: { messageId, acknowledgedAt: null, reminderMessageId: null,
        reminderError: { not: null },
      },
    })
    if (claimed.count > 0 || failed > 0) {
      await enqueueQueueJob(tx, {
        topic: 'announcement.remind',
        payload: { messageId, senderUserId: actorContext.actor.actorId,
          organizationId: actorContext.tenant.organizationId },
        idempotencyKey: `announcement-remind:${messageId}:${randomUUID()}`,
        maxAttempts: 8,
      })
      await writeAuditEntryInTransaction(tx, {
        organizationId: actorContext.tenant.organizationId,
        projectId: actorContext.tenant.projectId,
        teamId: message.thread.channel.teamId,
        channelId: message.thread.channel.id,
        actorType: 'user', actorId: actorContext.actor.actorId,
        action: 'announcement.reminder_requested', resourceType: 'announcement',
        resourceId: messageId, outcome: 'success',
        requestId: actorContext.actionContext.requestId,
        metadata: { claimed: claimed.count, retrying: failed },
      })
    }
    return claimed.count + failed
  })
}
