import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext, TeamMemberRecord } from '@nessie/schemas'
import { resolveLiveEntitlementDecision } from '@nessie/runtime'
import { enqueueQueueJob } from '@nessie/db'

import {
  listOrganisationMembers,
  listTeamMembers,
  withUoaOrgRosterSubjectAssertion,
  withUoaRosterSubjectAssertion,
} from './uoa-org-roster.js'

export type AnnouncementRecipient =
  | { recipientUoaSub: string; localUserId?: string; displayName?: string }
  | { recipientUserId: string; localUserId: string; displayName?: string }

export class AnnouncementAudienceIncompleteError extends Error {}
export class AnnouncementMembershipUnavailableError extends Error {}

type AudienceChannel = {
  organizationId: string
  teamId: string
  project: { channelRoot: boolean }
  organization: { externalOrgId: string | null }
  team: { externalTeamId: string | null }
}

const listAllPages = async (
  load: (cursor?: string) => Promise<{
    items: TeamMemberRecord[]
    meta: { hasMore: boolean; nextCursor: string | null }
  }>,
): Promise<TeamMemberRecord[]> => {
  const result: TeamMemberRecord[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
    const page = await load(cursor)
    result.push(...page.items)
    if (!page.meta.hasMore) return result
    const nextCursor = page.meta.nextCursor
    if (!nextCursor || cursors.has(nextCursor)) {
      throw new AnnouncementAudienceIncompleteError('Incomplete UOA announcement roster')
    }
    cursors.add(nextCursor)
    cursor = nextCursor
  }
  throw new AnnouncementAudienceIncompleteError('UOA announcement roster exceeded page bound')
}

/** Freeze the exact active scope, with UOA subjects instead of mirrored people. */
export const listAnnouncementRecipients = async (
  prisma: PrismaClient,
  channel: AudienceChannel,
  actorContext: AuthorizedActionContext,
  authorUserId: string,
): Promise<AnnouncementRecipient[]> => {
  const externalOrgId = channel.organization.externalOrgId
  if (externalOrgId) {
    const identity = actorContext.actionContext.uoaIdentity
    if (!identity) throw new Error('A UOA announcement requires a verified session')
    const author = await prisma.user.findUnique({
      where: { id: authorUserId }, select: { uoaSub: true },
    })
    if (!author?.uoaSub) throw new Error('Announcement author has no UOA subject')
    const roster = channel.project.channelRoot
      ? await listAllPages((cursor) => listOrganisationMembers(
        externalOrgId,
        { status: 'ACTIVE', limit: 100, ...(cursor ? { cursor } : {}) },
        withUoaOrgRosterSubjectAssertion(externalOrgId, identity),
      ))
      : await listAllPages((cursor) => {
        if (!channel.team.externalTeamId) throw new Error('Team has no UOA reference')
        const team = { externalOrgId, externalTeamId: channel.team.externalTeamId }
        return listTeamMembers(
          team,
          { status: 'ACTIVE', limit: 100, ...(cursor ? { cursor } : {}) },
          withUoaRosterSubjectAssertion(team, identity),
        )
      })
    if (roster.some((member) => member.status !== 'ACTIVE')) {
      throw new AnnouncementAudienceIncompleteError('UOA returned an incomplete active announcement roster')
    }
    const subjects = [...new Set(roster.filter((member) =>
      member.uoaSub !== author.uoaSub,
    ).map((member) => member.uoaSub))]
    const users = subjects.length > 0 ? await prisma.user.findMany({
      where: { uoaSub: { in: subjects }, organizationMembers: { some: {
        organizationId: channel.organizationId, deactivatedAt: null,
      } } },
      select: { id: true, uoaSub: true },
    }) : []
    const userBySubject = new Map(users.flatMap((user) =>
      user.uoaSub ? [[user.uoaSub, user.id] as const] : [],
    ))
    const nameBySubject = new Map(roster.flatMap((member) =>
      member.displayName ? [[member.uoaSub, member.displayName] as const] : [],
    ))
    return subjects.map((recipientUoaSub) => ({
      recipientUoaSub,
      ...(nameBySubject.has(recipientUoaSub)
        ? { displayName: nameBySubject.get(recipientUoaSub) }
        : {}),
      ...(userBySubject.has(recipientUoaSub)
        ? { localUserId: userBySubject.get(recipientUoaSub) }
        : {}),
    }))
  }

  const memberships = channel.project.channelRoot
    ? await prisma.organizationMember.findMany({
      where: { organizationId: channel.organizationId, deactivatedAt: null, userId: { not: authorUserId } },
      select: { userId: true, user: { select: { displayName: true } } },
    })
    : await prisma.teamMember.findMany({
      where: { teamId: channel.teamId, userId: { not: authorUserId },
        user: { organizationMembers: { some: {
          organizationId: channel.organizationId, deactivatedAt: null,
        } } },
      },
      select: { userId: true, user: { select: { displayName: true } } },
    })
  return [...new Map(memberships.map((member) => [member.userId, member])).values()].map((member) => ({
    recipientUserId: member.userId,
    displayName: member.user.displayName,
    localUserId: member.userId,
  }))
}

/** Both receipt and bell alert commit with the message. */
export const persistAnnouncementAudience = async (
  tx: Prisma.TransactionClient,
  input: {
    messageId: string
    organizationId: string
    channelId: string
    threadId: string
    rootMessageId?: string
    authorUserId: string
    recipients: AnnouncementRecipient[]
    mentionedUserIds: string[]
  },
): Promise<string[]> => {
  await tx.announcementDelivery.createMany({
    data: input.recipients.map((recipient) => ({
      messageId: input.messageId,
      ...('recipientUoaSub' in recipient
        ? { recipientUoaSub: recipient.recipientUoaSub }
        : { recipientUserId: recipient.recipientUserId }),
    })),
    skipDuplicates: true,
  })
  const announcementUserIds = new Set(input.recipients.flatMap((recipient) =>
    recipient.localUserId ? [recipient.localUserId] : [],
  ))
  const allUserIds = [...new Set([...announcementUserIds, ...input.mentionedUserIds])]
    .filter((userId) => userId !== input.authorUserId)
  if (allUserIds.length > 0) {
    await tx.userAlert.createMany({
      data: allUserIds.map((userId) => ({
        organizationId: input.organizationId,
        userId,
        kind: 'mention' as const,
        isAnnouncement: announcementUserIds.has(userId),
        eventKey: `announcement:${input.messageId}`,
        messageId: input.messageId,
        channelId: input.channelId,
        threadId: input.threadId,
        ...(input.rootMessageId ? { rootMessageId: input.rootMessageId } : {}),
        actorUserId: input.authorUserId,
      })),
      skipDuplicates: true,
    })
  }
  return allUserIds
}

/** First product visit turns a subject entitlement into the normal bell row. */
export const materializeAnnouncementAlerts = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
): Promise<void> => {
  const identity = actorContext.actionContext.uoaIdentity
  if (!identity || actorContext.actor.actorType !== 'user') return
  const userId = actorContext.actor.actorId
  const organizationId = actorContext.tenant.organizationId
  const deliveries = await prisma.announcementDelivery.findMany({
    where: { recipientUoaSub: identity.subject,
      message: { deletedAt: null, thread: { channel: { organizationId } } },
    },
    include: { message: { select: {
      createdAt: true, userId: true, threadId: true, rootMessageId: true,
      thread: { select: { channel: { select: {
        id: true, teamId: true, project: { select: { channelRoot: true } },
      } } } },
    } } },
  })
  if (deliveries.length === 0) return
  const decision = await resolveLiveEntitlementDecision(prisma, {
    organizationId, userId, uoaIdentity: identity,
  })
  if (decision.status !== 'allowed' || decision.entitlements.kind !== 'uoa') return
  const currentTeamIds = decision.entitlements.teamIds
  const rows = deliveries.filter((delivery) => {
    const channel = delivery.message.thread.channel
    return channel.project.channelRoot || currentTeamIds.includes(channel.teamId)
  }).map((delivery) => ({
    organizationId,
    userId,
    kind: 'mention' as const,
    isAnnouncement: true,
    eventKey: `announcement:${delivery.messageId}`,
    messageId: delivery.messageId,
    threadId: delivery.message.threadId,
    rootMessageId: delivery.message.rootMessageId,
    channelId: delivery.message.thread.channel.id,
    actorUserId: delivery.message.userId,
    createdAt: delivery.message.createdAt,
  }))
  if (rows.length > 0) await prisma.userAlert.createMany({ data: rows, skipDuplicates: true })
  for (const delivery of deliveries) {
    if (!delivery.reminderClaimedAt || delivery.reminderMessageId || delivery.acknowledgedAt
      || !delivery.message.userId) continue
    await enqueueQueueJob(prisma, {
      topic: 'announcement.remind',
      payload: { messageId: delivery.messageId, senderUserId: delivery.message.userId,
        organizationId },
      idempotencyKey: `announcement-remind:login:${delivery.messageId}:${userId}`,
      maxAttempts: 8,
    })
  }
}

/** A current request's team set, never a durable UOA membership projection. */
export const currentAnnouncementTeamIds = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
): Promise<string[]> => {
  const userId = actorContext.actor.actorId
  const organizationId = actorContext.tenant.organizationId
  const decision = await resolveLiveEntitlementDecision(prisma, {
    organizationId, userId,
    ...(actorContext.actionContext.uoaIdentity
      ? { uoaIdentity: actorContext.actionContext.uoaIdentity } : {}),
  })
  if (decision.status === 'unavailable') throw new AnnouncementMembershipUnavailableError()
  if (decision.status === 'denied') return []
  if (decision.entitlements.kind === 'uoa') return [...decision.entitlements.teamIds]
  const teams = await prisma.teamMember.findMany({
    where: { userId, team: { project: { organizationId } } }, select: { teamId: true },
  })
  return teams.map((team) => team.teamId)
}
