import type { PrismaClient } from '@prisma/client'

const SHARED_MAILBOX_MANAGER_ROLES = ['owner', 'admin'] as const

export type MailboxConnectionApprover = {
  createdByUserId: string | null
  organizationId: string
  ownerUserId: string | null
  teamId: string | null
}

/**
 * The one live person who may decide a connected-mailbox send.
 *
 * Personal correspondence remains with its owner. A shared mailbox's
 * accountable installer must remain an active organisation manager: an old
 * installer who was demoted cannot keep approving mail sent by the team.
 */
export const currentMailboxConnectionApprover = async (
  prisma: Pick<PrismaClient, 'organizationMember'>,
  connection: MailboxConnectionApprover,
): Promise<string | null> => {
  const userId = connection.ownerUserId ?? connection.createdByUserId
  if (!userId) return null

  const member = await prisma.organizationMember.findFirst({
    select: { userId: true },
    where: {
      deactivatedAt: null,
      organizationId: connection.organizationId,
      userId,
      ...(connection.ownerUserId === null && connection.teamId !== null
        ? { role: { in: [...SHARED_MAILBOX_MANAGER_ROLES] } }
        : {}),
    },
  })
  return member?.userId ?? null
}

/** Whether an actor can still complete an explicit mailbox recovery. */
export const canReconnectMailboxConnection = async (
  prisma: Pick<PrismaClient, 'organizationMember'>,
  connection: MailboxConnectionApprover,
  actorUserId: string,
): Promise<boolean> => {
  if (connection.ownerUserId !== null && connection.ownerUserId !== actorUserId) return false
  if (connection.ownerUserId === null && connection.teamId === null) return false

  const member = await prisma.organizationMember.findFirst({
    select: { userId: true },
    where: {
      deactivatedAt: null,
      organizationId: connection.organizationId,
      userId: actorUserId,
      ...(connection.ownerUserId === null
        ? { role: { in: [...SHARED_MAILBOX_MANAGER_ROLES] } }
        : {}),
    },
  })
  return Boolean(member)
}
