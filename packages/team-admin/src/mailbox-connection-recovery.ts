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

  const secretCiphertext = sealSecret(options.encryptionSecret, input.password)
  const updated = await prisma.$transaction(async (tx) => {
    const connection = await tx.mailboxConnection.update({
      data: {
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
      where: { id: input.connection.id },
    })
    await tx.mailboxConnectionCredential.upsert({
      create: {
        connectionId: connection.id,
        secretCiphertext,
      },
      update: {
        secretCiphertext,
      },
      where: { connectionId: connection.id },
    })
    await resolveMailboxConnectionHealthAlerts(tx, connection.id)
    return connection
  })
  return presentMailboxConnection(updated)
}
