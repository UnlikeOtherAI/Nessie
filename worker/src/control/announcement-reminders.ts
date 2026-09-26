import { Prisma, type PrismaClient } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import { publishMessageEnvelope, resolveLiveEntitlementDecision,
  type MessageEnvelopePublisher } from '@nessie/runtime'
import { isAdminRole, parseChannelId,
  type AnnouncementReminderJobPayload } from '@nessie/schemas'
import { ensureDefaultThread, isAnnouncementAdministrator } from '@nessie/team-admin'

type ReminderDeps = { prisma: PrismaClient; realtimeTransport: MessageEnvelopePublisher | null }

const liveEntitlement = (prisma: PrismaClient, organizationId: string, userId: string) =>
  resolveLiveEntitlementDecision(prisma, { allowStoredIdentity: true, organizationId, userId })

export const handleAnnouncementReminders = async (
  deps: ReminderDeps,
  payload: AnnouncementReminderJobPayload,
): Promise<void> => {
  const { prisma } = deps
  const message = await prisma.message.findFirst({
    where: { id: payload.messageId, userId: payload.senderUserId,
      requiresConfirmation: true, deletedAt: null,
      thread: { channel: { organizationId: payload.organizationId } },
    },
    select: { id: true, threadId: true, userId: true,
      thread: { select: { channel: { select: {
        id: true, organizationId: true, projectId: true, teamId: true,
        type: true, systemChannelType: true,
        project: { select: { channelRoot: true } },
        organization: { select: { externalOrgId: true } },
        team: { select: { externalTeamId: true } },
      } } } },
    },
  })
  if (!message) return
  const channel = message.thread.channel
  const markOutstandingError = async (reason: string): Promise<void> => {
    await prisma.announcementDelivery.updateMany({
      where: { messageId: message.id, acknowledgedAt: null, reminderMessageId: null,
        reminderClaimedAt: { not: null } },
      data: { reminderError: reason },
    })
  }
  const senderCanRemind = async (): Promise<boolean> => {
    if (!(await prisma.channelMember.count({ where: {
      channelId: channel.id, userId: payload.senderUserId,
    } }))) return false
    const senderDecision = await liveEntitlement(prisma, payload.organizationId, payload.senderUserId)
    if (senderDecision.status === 'unavailable') {
      await markOutstandingError('Administrator membership could not be verified')
      throw new Error('UOA unavailable for reminder sender')
    }
    if (senderDecision.status !== 'allowed') return false
    if (senderDecision.entitlements.kind === 'uoa') {
      return isAnnouncementAdministrator({
        channelType: channel.type, systemChannelType: channel.systemChannelType,
        isOrganizationAdmin: isAdminRole(senderDecision.entitlements.organizationRole),
        externalOrgId: channel.organization.externalOrgId,
        externalTeamId: channel.team.externalTeamId,
        uoaTeamRoles: senderDecision.entitlements.teamRoles,
      })
    }
    const [orgMember, teamMember] = await Promise.all([
        prisma.organizationMember.findFirst({
          where: { organizationId: payload.organizationId, userId: payload.senderUserId,
            deactivatedAt: null }, select: { role: true },
        }),
        prisma.teamMember.findUnique({
          where: { teamId_userId: { teamId: channel.teamId,
            userId: payload.senderUserId } }, select: { role: true },
        }),
    ])
    return isAnnouncementAdministrator({
        channelType: channel.type, systemChannelType: channel.systemChannelType,
        isOrganizationAdmin: isAdminRole(orgMember?.role),
        externalOrgId: null, externalTeamId: null,
        localTeamRole: teamMember?.role,
    })
  }
  const senderAdmin = await senderCanRemind()
  if (!senderAdmin) {
    await prisma.announcementDelivery.updateMany({
      where: { messageId: message.id, acknowledgedAt: null, reminderMessageId: null,
        reminderClaimedAt: { not: null } },
      data: { reminderError: 'Sender can no longer remind from this channel' },
    })
    return
  }

  const receipts = await prisma.announcementDelivery.findMany({
    where: { messageId: message.id, acknowledgedAt: null,
      reminderClaimedAt: { not: null }, reminderMessageId: null },
    select: { id: true, recipientUoaSub: true, recipientUserId: true },
  })
  const subjects = receipts.flatMap((receipt) =>
    receipt.recipientUoaSub ? [receipt.recipientUoaSub] : [],
  )
  const subjectUsers = subjects.length ? await prisma.user.findMany({
    where: { uoaSub: { in: subjects } }, select: { id: true, uoaSub: true },
  }) : []
  const userBySubject = new Map(subjectUsers.flatMap((user) =>
    user.uoaSub ? [[user.uoaSub, user.id] as const] : [],
  ))
  for (const receipt of receipts) {
    if (!(await senderCanRemind())) {
      await prisma.announcementDelivery.updateMany({
        where: { messageId: message.id, acknowledgedAt: null,
          reminderMessageId: null, reminderClaimedAt: { not: null } },
        data: { reminderError: 'Sender can no longer remind from this channel' },
      })
      return
    }
    const recipientUserId = receipt.recipientUserId
      ?? (receipt.recipientUoaSub ? userBySubject.get(receipt.recipientUoaSub) : undefined)
    if (!recipientUserId || recipientUserId === payload.senderUserId) continue
    const decision = await liveEntitlement(prisma, payload.organizationId, recipientUserId)
    if (decision.status === 'unavailable') {
      await prisma.announcementDelivery.updateMany({
        where: { id: receipt.id, acknowledgedAt: null, reminderMessageId: null },
        data: { reminderError: 'Recipient membership could not be verified' },
      })
      throw new Error('UOA unavailable for reminder recipient')
    }
    if (decision.status !== 'allowed') {
      await prisma.announcementDelivery.updateMany({
        where: { id: receipt.id, acknowledgedAt: null, reminderMessageId: null },
        data: { reminderError: 'Recipient is no longer in scope' },
      })
      continue
    }
    const eligible = channel.project.channelRoot
      ? true
      : decision.entitlements.kind === 'uoa'
        ? decision.entitlements.teamIds.includes(channel.teamId)
        : (await prisma.teamMember.count({
          where: { teamId: channel.teamId, userId: recipientUserId },
        })) > 0
    if (!eligible) {
      await prisma.announcementDelivery.updateMany({
        where: { id: receipt.id, acknowledgedAt: null, reminderMessageId: null },
        data: { reminderError: 'Recipient is no longer in scope' },
      })
      continue
    }

    try {
      const sent = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT id FROM announcement_deliveries WHERE id = ${receipt.id}::uuid FOR UPDATE
        `)
        const activeMessage = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT id FROM messages WHERE id = ${message.id}::uuid
            AND deleted_at IS NULL FOR SHARE
        `)
        if (activeMessage.length === 0) return null
        const current = await tx.announcementDelivery.findUnique({
          where: { id: receipt.id },
          select: { acknowledgedAt: true, reminderMessageId: true, reminderClaimedAt: true },
        })
        if (!current || current.acknowledgedAt || current.reminderMessageId
          || !current.reminderClaimedAt) return null
        const dmKey = [payload.organizationId, channel.teamId,
          ...[payload.senderUserId, recipientUserId].sort()].join(':')
        const dm = await tx.channel.upsert({
          where: { dmKey },
          create: { dmKey, label: 'Direct Message', type: 'dm', visibility: 'private',
            organizationId: payload.organizationId, teamId: channel.teamId,
            projectId: channel.projectId,
            members: { create: [payload.senderUserId, recipientUserId].map((userId) => ({ userId })) },
          },
          update: {},
          select: { id: true },
        })
        await tx.channelMember.createMany({
          data: [payload.senderUserId, recipientUserId].map((userId) => ({
            channelId: dm.id, userId,
          })), skipDuplicates: true,
        })
        const threadId = await ensureDefaultThread(tx, dm.id)
        const url = `/channels/${channel.id}/threads/${message.threadId}/replies/${message.id}`
        const content = `[Go take a look at this](${url})`
        const dmMessage = await tx.message.create({
          data: { threadId, role: 'user', userId: payload.senderUserId, content },
          select: { id: true },
        })
        await tx.announcementDelivery.update({
          where: { id: receipt.id },
          data: { reminderMessageId: dmMessage.id, reminderError: null },
        })
        await enqueueQueueJob(tx, {
          topic: 'push.dispatch', idempotencyKey: `push:${dmMessage.id}`,
          payload: { messageId: dmMessage.id, authorUserId: payload.senderUserId,
            recipientUserIds: [recipientUserId], channelId: dm.id, threadId,
            organizationId: payload.organizationId, contentSnippet: content,
            mentionUserIds: [],
          },
        })
        return { channelId: dm.id, threadId, messageId: dmMessage.id, content }
      })
      if (sent && deps.realtimeTransport) {
        try {
          await publishMessageEnvelope(deps.realtimeTransport,
            [{ kind: 'channel', channelId: parseChannelId(sent.channelId) }],
            { channelId: sent.channelId, threadId: sent.threadId,
              message: { id: sent.messageId, content: sent.content,
                role: 'user', userId: payload.senderUserId },
            }, { idempotencyKey: `announcement-reminder:${sent.messageId}` },
          )
        } catch { /* persisted message and push outbox remain authoritative */ }
      }
    } catch (error) {
      await prisma.announcementDelivery.updateMany({
        where: { id: receipt.id, reminderMessageId: null },
        data: { reminderError: 'Reminder delivery failed' },
      })
      throw error
    }
  }
}
