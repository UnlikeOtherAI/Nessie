import type { Prisma, PrismaClient } from '@prisma/client'

import type { UoaPendingTeamInvite } from './uoa-team-directory.js'

const inviteEventKey = (inviteId: string): string =>
  `team-invite:${inviteId}`

const inviteMetadata = (
  invite: UoaPendingTeamInvite,
): Prisma.InputJsonObject => ({
  inviteId: invite.inviteId,
  organizationId: invite.organizationId,
  teamId: invite.teamId,
  teamName: invite.teamName,
  ...(invite.invitedBy ? { invitedBy: invite.invitedBy } : {}),
  ...(invite.expiresAt ? { expiresAt: invite.expiresAt } : {}),
})

/**
 * Reconcile the caller's durable invite attention against one verified UOA
 * directory response. Rows move to the current session organisation so the
 * bell the person is looking at owns the action. Vanished invites are deleted,
 * not marked read: UOA owns this data and Nessie must not retain a stale copy.
 */
export const syncTeamInviteAlerts = async (
  prisma: PrismaClient,
  input: {
    userId: string
    organizationId: string
    pendingInvites: UoaPendingTeamInvite[]
  },
): Promise<void> => {
  const eventKeys = input.pendingInvites.map((invite) => inviteEventKey(invite.inviteId))

  await prisma.$transaction(async (transaction) => {
    for (const invite of input.pendingInvites) {
      const eventKey = inviteEventKey(invite.inviteId)
      await transaction.userAlert.upsert({
        where: {
          userId_eventKey: { userId: input.userId, eventKey },
        },
        create: {
          actorAgentId: null,
          actorUserId: null,
          eventKey,
          kind: 'team_invitation',
          metadata: inviteMetadata(invite),
          organizationId: input.organizationId,
          userId: input.userId,
        },
        update: {
          actorAgentId: null,
          actorUserId: null,
          kind: 'team_invitation',
          metadata: inviteMetadata(invite),
          organizationId: input.organizationId,
        },
      })
    }

    await transaction.userAlert.deleteMany({
      where: {
        kind: 'team_invitation',
        userId: input.userId,
        ...(eventKeys.length > 0 ? { eventKey: { notIn: eventKeys } } : {}),
      },
    })
  })
}
