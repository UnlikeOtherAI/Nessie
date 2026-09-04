import type { PrismaClient } from '@prisma/client'
import {
  capabilityIsGranted,
  type ConnectedMailSource,
  type MailSurfaceDoorwayMode,
} from '@nessie/schemas'

import {
  MailboxAccessError,
  listReachableMailboxes,
  type ReachableMailbox,
} from './mailbox-connection-access.js'

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

type ActiveMember = { deactivatedAt: Date | null }

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

const gmailCapabilityForMode = (mode: MailSurfaceDoorwayMode): 'gmail.read' | 'gmail.compose' =>
  mode === 'compose' ? 'gmail.compose' : 'gmail.read'

const activeMemberFor = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string },
): Promise<ActiveMember> => {
  const member = await prisma.organizationMember.findUnique({
    select: { deactivatedAt: true },
    where: { organizationId_userId: input },
  })
  if (!member || member.deactivatedAt) {
    throw new ConnectedMailPresentationError('That mail account is not available to you.')
  }
  return member
}

const isSharedMailboxViewer = async (
  prisma: PrismaClient,
  input: { teamId: string; userId: string },
): Promise<boolean> => {
  const membership = await prisma.teamMember.findUnique({
    select: { id: true },
    where: { teamId_userId: { teamId: input.teamId, userId: input.userId } },
  })
  return Boolean(membership)
}

const resolvePresentationMailbox = async (
  prisma: PrismaClient,
  input: {
    accountId?: string
    agentId: string
    effectiveUserId: string
    organizationId: string
  },
): Promise<ReachableMailbox> => {
  const candidates = await listReachableMailboxes(prisma, input)
  const visible: ReachableMailbox[] = []
  for (const candidate of candidates) {
    if (candidate.scope === 'user') {
      visible.push(candidate)
      continue
    }
    const teamId = candidate.connection.teamId
    if (teamId && await isSharedMailboxViewer(prisma, { teamId, userId: input.effectiveUserId })) {
      visible.push(candidate)
    }
  }
  if (visible.length === 0) {
    throw new ConnectedMailPresentationError('That mail account is not available to you.')
  }
  if (input.accountId) {
    const named = visible.find((candidate) => candidate.connection.id === input.accountId)
    if (!named) throw new ConnectedMailPresentationError('That mail account is not available to you.')
    return named
  }
  if (visible.length > 1) {
    const options = visible.map((candidate) =>
      `${candidate.connection.label} (${candidate.connection.id})`).join('; ')
    throw new MailboxAccessError(
      'AMBIGUOUS_MAILBOX',
      `I can reach more than one mailbox, so tell me which to use by passing connectionId: ${options}.`,
    )
  }
  const only = visible[0]
  if (!only) throw new ConnectedMailPresentationError('That mail account is not available to you.')
  return only
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
  await activeMemberFor(prisma, {
    organizationId: input.organizationId,
    userId: input.effectiveUserId,
  })
  const mailbox = await resolvePresentationMailbox(prisma, {
    agentId: input.agentId,
    accountId: input.accountId,
    effectiveUserId: input.effectiveUserId,
    organizationId: input.organizationId,
  })
  return {
    accountId: mailbox.connection.id,
    basis: mailbox.basis,
    source: 'mailbox',
  }
}

const resolveGmailPresentationAccess = async (
  prisma: PrismaClient,
  input: {
    accountId: string
    draftId?: string
    effectiveUserId: string | null
    mode: MailSurfaceDoorwayMode
    organizationId: string
  },
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
    select: { disabledCapabilities: true, grantedScopes: true, id: true, ownerUserId: true },
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
  const capability = gmailCapabilityForMode(input.mode)
  if (
    !capabilityIsGranted(capability, strings(connection.grantedScopes))
    || strings(connection.disabledCapabilities).includes(capability)
  ) {
    throw new ConnectedMailPresentationError('That mail account is not available to you.')
  }
  if (input.draftId) {
    const draft = await prisma.gmailDraftAction.findFirst({
      where: {
        connectionId: connection.id,
        id: input.draftId,
        organizationId: input.organizationId,
        ownerUserId: input.effectiveUserId,
      },
    })
    if (!draft) throw new ConnectedMailPresentationError('That mail account is not available to you.')
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
    draftId?: string
    effectiveUserId: string | null
    mode: MailSurfaceDoorwayMode
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
    draftId: input.draftId,
    effectiveUserId: input.effectiveUserId,
    mode: input.mode,
    organizationId: input.organizationId,
  })
}
