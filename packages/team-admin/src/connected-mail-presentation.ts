import type { PrismaClient } from '@prisma/client'
import type { ConnectedMailSource } from '@nessie/schemas'

import { MailboxAccessError, resolveMailboxForToolCall } from './mailbox-connection-access.js'

/**
 * Authorization for an agent-created doorway into the connected-mail surface.
 *
 * A doorway contains no provider content, but it grants a client a reason to
 * open a private surface. It therefore repeats the live viewer entitlement
 * checks instead of treating a run's older actor context as authority. The API
 * mail routes should use this same seam when they land.
 */
export class ConnectedMailPresentationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectedMailPresentationError'
  }
}

export type ConnectedMailPresentationAccess = {
  accountId: string
  basis: { scopeId: string; scopeType: 'user' | 'team' }
  source: ConnectedMailSource
}

type ActiveMember = { role: string; deactivatedAt: Date | null }

const activeMemberFor = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string },
): Promise<ActiveMember> => {
  const member = await prisma.organizationMember.findUnique({
    select: { deactivatedAt: true, role: true },
    where: { organizationId_userId: input },
  })
  if (!member || member.deactivatedAt) {
    throw new ConnectedMailPresentationError('That mail account is not available to you.')
  }
  return member
}

const assertSharedMailboxViewer = async (
  prisma: PrismaClient,
  input: { member: ActiveMember; teamId: string; userId: string },
): Promise<void> => {
  if (input.member.role === 'owner' || input.member.role === 'admin') return
  const membership = await prisma.teamMember.findUnique({
    select: { id: true },
    where: { teamId_userId: { teamId: input.teamId, userId: input.userId } },
  })
  if (!membership) {
    throw new ConnectedMailPresentationError('That mail account is not available to you.')
  }
}

const resolveMailboxPresentationAccess = async (
  prisma: PrismaClient,
  input: {
    accountId?: string
    agentId: string
    effectiveUserId: string | null
    organizationId: string
  },
): Promise<ConnectedMailPresentationAccess> => {
  if (!input.effectiveUserId) {
    throw new MailboxAccessError(
      'NO_MAILBOX',
      'I can only open a connected mailbox for the person who is asking right now.',
    )
  }
  const mailbox = await resolveMailboxForToolCall(prisma, {
    agentId: input.agentId,
    connectionId: input.accountId,
    effectiveUserId: input.effectiveUserId,
    organizationId: input.organizationId,
  })
  const member = await activeMemberFor(prisma, {
    organizationId: input.organizationId,
    userId: input.effectiveUserId,
  })
  if (mailbox.scope === 'team') {
    const teamId = mailbox.connection.teamId
    if (!teamId) {
      throw new ConnectedMailPresentationError('That mail account is not available to you.')
    }
    await assertSharedMailboxViewer(prisma, {
      member,
      teamId,
      userId: input.effectiveUserId,
    })
  }
  return {
    accountId: mailbox.connection.id,
    basis: mailbox.basis,
    source: 'mailbox',
  }
}

const resolveGmailPresentationAccess = async (
  prisma: PrismaClient,
  input: { accountId: string; effectiveUserId: string | null; organizationId: string },
): Promise<ConnectedMailPresentationAccess> => {
  if (!input.effectiveUserId) {
    throw new ConnectedMailPresentationError(
      'I can only open a Google mail account for the person who is asking right now.',
    )
  }
  await activeMemberFor(prisma, {
    organizationId: input.organizationId,
    userId: input.effectiveUserId,
  })
  const connection = await prisma.commsConnection.findFirst({
    select: { id: true, ownerUserId: true },
    where: {
      id: input.accountId,
      organizationId: input.organizationId,
      ownerUserId: input.effectiveUserId,
      provider: 'google',
      status: 'active',
    },
  })
  if (!connection) {
    throw new ConnectedMailPresentationError('That mail account is not available to you.')
  }
  return {
    accountId: connection.id,
    basis: { scopeId: connection.ownerUserId, scopeType: 'user' },
    source: 'gmail',
  }
}

/**
 * Resolve a doorway's account and prove the current requester can open it.
 *
 * This intentionally does not decrypt a credential or contact a provider: it
 * is presentation only. Provider reads and sends keep their own capability and
 * approval gates.
 */
export const resolveConnectedMailPresentationAccess = async (
  prisma: PrismaClient,
  input: {
    accountId?: string
    agentId: string
    effectiveUserId: string | null
    organizationId: string
    source: ConnectedMailSource
  },
): Promise<ConnectedMailPresentationAccess> => {
  if (input.source === 'mailbox') {
    return resolveMailboxPresentationAccess(prisma, input)
  }
  if (!input.accountId) {
    throw new ConnectedMailPresentationError('Choose a Google mail account first.')
  }
  return resolveGmailPresentationAccess(prisma, {
    accountId: input.accountId,
    effectiveUserId: input.effectiveUserId,
    organizationId: input.organizationId,
  })
}
