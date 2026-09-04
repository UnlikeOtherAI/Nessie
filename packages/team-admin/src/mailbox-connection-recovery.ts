import type { PrismaClient } from '@prisma/client'
import { testMailboxConnection, type MailSecurity } from '@nessie/agent-mail'
import { sealSecret } from '@nessie/comms-connect'
import type { MailboxConnectionRecord } from '@nessie/schemas'

import {
  mailboxConnectionFailureMessage,
  mailboxConnectionTestFailure,
  MailboxConnectionError,
  presentMailboxConnection,
  type MailboxConnectionHealthTransition,
} from './mailbox-connections.js'
import {
  mailboxDialOptions,
  type MailboxConnectionRow,
} from './mailbox-connection-endpoints.js'
import { canReconnectMailboxConnection } from './mailbox-connection-approver.js'

/**
 * Move a mailbox into the explicit-recovery state and write its durable alert
 * as one transaction. The conditional update claims the transition, so
 * concurrent provider rejections create exactly one alert for this revision.
 */
export const recordMailboxConnectionCredentialRejection = async (
  prisma: PrismaClient,
  connectionId: string,
): Promise<MailboxConnectionHealthTransition | null> =>
  prisma.$transaction(async (tx) => {
    const connection = await tx.mailboxConnection.findUnique({
      select: {
        createdByUserId: true,
        organizationId: true,
        ownerUserId: true,
        teamId: true,
      },
      where: { id: connectionId },
    })
    if (!connection) return null

    const transitioned = await tx.mailboxConnection.updateMany({
      data: {
        healthRevision: { increment: 1 },
        status: 'needs_reauthorization',
        statusReason: mailboxConnectionFailureMessage('credential_rejected'),
      },
      where: { id: connectionId, status: 'active' },
    })
    if (transitioned.count !== 1) return null

    const refreshed = await tx.mailboxConnection.findUniqueOrThrow({
      select: { healthRevision: true },
      where: { id: connectionId },
    })
    const accountableUserId = connection.ownerUserId ?? connection.createdByUserId
    const accountableMember = accountableUserId
      ? await tx.organizationMember.findFirst({
        select: { userId: true },
        where: {
          deactivatedAt: null,
          organizationId: connection.organizationId,
          userId: accountableUserId,
          ...(connection.teamId ? { role: { in: ['owner', 'admin'] } } : {}),
        },
      })
      : null
    // A shared mailbox is repairable by an active owner/admin. If the original
    // connector has left the organisation, route the one alert to one of those
    // managers. Never apply this fallback to a personal mailbox: its contents
    // and credential authority remain solely with its owner.
    const fallbackManager = !accountableMember && connection.teamId
      ? await tx.organizationMember.findFirst({
        orderBy: { createdAt: 'asc' },
        select: { userId: true },
        where: {
          deactivatedAt: null,
          organizationId: connection.organizationId,
          role: { in: ['owner', 'admin'] },
        },
      })
      : null
    const recipient = accountableMember ?? fallbackManager
    if (recipient) {
      await tx.userAlert.createMany({
        data: [{
          eventKey: `mailbox-health:${connectionId}:${refreshed.healthRevision}`,
          kind: 'mailbox_connection_health',
          mailboxConnectionId: connectionId,
          organizationId: connection.organizationId,
          userId: recipient.userId,
        }],
        skipDuplicates: true,
      })
    }

    return { connectionId, healthRevision: refreshed.healthRevision }
  })

export type ReconnectMailboxConnectionInput = {
  /** The live manager who performed this explicit recovery. */
  actorUserId: string
  connection: MailboxConnectionRow
  imapHost: string
  imapPort: number
  imapSecurity: MailSecurity
  password: string
  smtpHost: string
  smtpPort: number
  smtpSecurity: MailSecurity
  username: string
}

type PersistMailboxReconnectionInput = Omit<ReconnectMailboxConnectionInput, 'connection' | 'password'> & {
  connectionId: string
  secretCiphertext: string
}

/**
 * An explicit successful recovery consumes the alert for the failed revision.
 * Later credential rejection gets a new revision and therefore one new unread
 * alert, rather than reviving every old failure alongside it.
 */
export const resolveMailboxConnectionHealthAlerts = async (
  prisma: Pick<PrismaClient, 'userAlert'>,
  connectionId: string,
): Promise<void> => {
  await prisma.userAlert.updateMany({
    data: { readAt: new Date() },
    where: {
      kind: 'mailbox_connection_health',
      mailboxConnectionId: connectionId,
      readAt: null,
    },
  })
}

/**
 * Persist a credential replacement after its two mail legs have been tested.
 *
 * A shared mailbox's `createdByUserId` is also its future send approver. A
 * manager taking over explicit recovery must become that accountable person;
 * retaining a deactivated original installer would make the recovered mailbox
 * unable to send. Personal mailboxes intentionally retain their owner and
 * creator: an admin can never take over somebody else's correspondence.
 */
export const persistMailboxReconnection = async (
  prisma: PrismaClient,
  input: PersistMailboxReconnectionInput,
): Promise<MailboxConnectionRecord> => {
  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.mailboxConnection.findUnique({
      select: {
        createdByUserId: true,
        organizationId: true,
        ownerUserId: true,
        teamId: true,
      },
      where: { id: input.connectionId },
    })
    if (!current) {
      throw new MailboxConnectionError('connection_not_found', 'That mailbox connection is gone.')
    }
    // The provider test happens before this transaction and can take seconds.
    // Re-read both the exact connection scope and live membership here, where
    // the credential write, activation, approver transfer, and alert cleanup
    // are still one all-or-nothing action.
    if (!await canReconnectMailboxConnection(tx, current, input.actorUserId)) {
      throw new MailboxConnectionError(
        'not_permitted',
        'You no longer have permission to reconnect this mailbox.',
      )
    }
    const isShared = current.ownerUserId === null && current.teamId !== null
    const approverTransferred = isShared && current.createdByUserId !== input.actorUserId
    const connection = await tx.mailboxConnection.update({
      data: {
        ...(isShared ? { createdByUserId: input.actorUserId } : {}),
        healthRevision: { increment: 1 },
        imapHost: input.imapHost,
        imapPort: input.imapPort,
        imapSecurity: input.imapSecurity,
        lastVerifiedAt: new Date(),
        smtpHost: input.smtpHost,
        smtpPort: input.smtpPort,
        smtpSecurity: input.smtpSecurity,
        status: 'active',
        statusReason: null,
        username: input.username,
      },
      include: { agentAccess: { select: { agentId: true } } },
      where: { id: input.connectionId },
    })
    await tx.mailboxConnectionCredential.upsert({
      create: {
        connectionId: connection.id,
        secretCiphertext: input.secretCiphertext,
      },
      update: {
        secretCiphertext: input.secretCiphertext,
      },
      where: { connectionId: connection.id },
    })
    if (approverTransferred) {
      // A former shared-mailbox approver must never retain a pending decision
      // or an approved continuation after a manager takes responsibility. The
      // connection id is structural context added by the mailbox gate; the
      // resume-state clause protects rows created before that context existed.
      await tx.approvalRequest.updateMany({
        data: {
          proofConsumedAt: new Date(),
          resolution: 'rejected',
          resolutionNote: 'Mailbox approver changed; propose the email again.',
          resolvedAt: new Date(),
          status: 'rejected',
        },
        where: {
          action: 'tool.invoke',
          organizationId: current.organizationId,
          OR: [
            { status: 'pending' },
            { proofConsumedAt: null, status: 'approved' },
          ],
          toolName: 'mailbox_send',
          AND: [{
            OR: [
              { context: { equals: input.connectionId, path: ['mailboxConnectionId'] } },
              { resumeState: { equals: input.connectionId, path: ['args', 'connectionId'] } },
            ],
          }],
        },
      })
    }
    await resolveMailboxConnectionHealthAlerts(tx, connection.id)
    return connection
  })
  return presentMailboxConnection(updated)
}

/**
 * Replace a mailbox credential only after the new settings have proved they
 * can authenticate and reach both IMAP and SMTP. The scoped connection and its
 * access rows are retained; reconnecting is recovery, not a second mailbox.
 */
export const reconnectMailboxConnection = async (
  prisma: PrismaClient,
  input: ReconnectMailboxConnectionInput,
  options: { encryptionSecret: string },
): Promise<MailboxConnectionRecord> => {
  const endpoints = {
    address: input.connection.address,
    imap: { host: input.imapHost, port: input.imapPort, security: input.imapSecurity },
    password: input.password,
    smtp: { host: input.smtpHost, port: input.smtpPort, security: input.smtpSecurity },
    username: input.username,
  }
  try {
    await testMailboxConnection(endpoints, mailboxDialOptions())
  } catch (error) {
    const failure = mailboxConnectionTestFailure(error)
    throw new MailboxConnectionError(failure, mailboxConnectionFailureMessage(failure))
  }

  return persistMailboxReconnection(prisma, {
    actorUserId: input.actorUserId,
    connectionId: input.connection.id,
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    imapSecurity: input.imapSecurity,
    secretCiphertext: sealSecret(options.encryptionSecret, input.password),
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecurity: input.smtpSecurity,
    username: input.username,
  })
}
