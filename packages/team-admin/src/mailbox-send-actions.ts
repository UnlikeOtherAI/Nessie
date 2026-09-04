import { createHash, randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import {
  buildOutboundMime,
  normalizeOutboundAddress,
  sendFromMailbox,
  SmtpError,
} from '@nessie/agent-mail'
import { canonicalDraftFingerprintInput } from '@nessie/comms-google'
import type { ConnectedMailboxSendInput } from '@nessie/schemas'

import {
  ConnectedMailError,
  mailboxForActor,
  type Actor,
  type ConnectedMailDeps,
} from './connected-mail.js'
import {
  MailboxCredentialMissingError,
  mailboxDialOptions,
  mailboxEndpointsFor,
  type MailboxConnectionRow,
} from './mailbox-connection-endpoints.js'
import { markMailboxNeedsReauthorization } from './mailbox-connection-access.js'
import { mailboxConnectionTestFailure } from './mailbox-connections.js'

const mailboxSendFingerprint = (input: ConnectedMailboxSendInput): string =>
  createHash('sha256').update(canonicalDraftFingerprintInput(input)).digest('hex')

const normalizeMailboxRecipients = (values: string[] | undefined): string[] | undefined => {
  if (!values) return undefined
  const normalized = values.map((value) => normalizeOutboundAddress(value))
  if (normalized.some((value) => !value)) throw new ConnectedMailError('INVALID_RECIPIENT')
  return normalized as string[]
}

const prepareMailboxSend = (input: ConnectedMailboxSendInput): ConnectedMailboxSendInput => {
  const prepared = {
    ...input,
    bcc: normalizeMailboxRecipients(input.bcc),
    cc: normalizeMailboxRecipients(input.cc),
    to: normalizeMailboxRecipients(input.to) ?? [],
  }
  if (prepared.to.length === 0) throw new ConnectedMailError('INVALID_RECIPIENT')
  return prepared
}

const preflightMailboxMime = (
  connection: MailboxConnectionRow,
  mail: ConnectedMailboxSendInput,
  messageId: string,
): void => {
  try {
    buildOutboundMime({
      bcc: mail.bcc, cc: mail.cc, fromAddress: connection.address,
      inReplyTo: mail.inReplyTo, messageId,
      references: mail.inReplyTo ? [mail.inReplyTo] : undefined,
      subject: mail.subject, text: mail.body, to: mail.to,
    })
  } catch {
    throw new ConnectedMailError('INVALID_RECIPIENT')
  }
}

const isDeterministicPreDataRejection = (error: unknown): boolean =>
  error instanceof SmtpError
  && !error.deliveryMayHaveStarted
  && (error.kind === 'recipient' || (error.code !== null && error.code >= 500))

/** Abandoned SMTP claims are ambiguous, and must never become sendable again. */
export const MAILBOX_SEND_STALE_CLAIM_WINDOW_MS = 2 * 60 * 1000

export const resolveStaleMailboxSendDispatches = async (
  prisma: PrismaClient,
  deps: { now?: () => Date } = {},
): Promise<Array<{ id: string; organizationId: string; ownerUserId: string; connectionId: string }>> => {
  const now = deps.now?.() ?? new Date()
  const staleAt = new Date(now.getTime() - MAILBOX_SEND_STALE_CLAIM_WINDOW_MS)
  const candidates = await prisma.mailboxSendAction.findMany({
    where: { state: 'dispatching', claimedAt: { lt: staleAt } },
    orderBy: { claimedAt: 'asc' },
    select: { connectionId: true, id: true, organizationId: true, ownerUserId: true },
    take: 50,
  })
  const settled: typeof candidates = []
  for (const candidate of candidates) {
    const result = await prisma.mailboxSendAction.updateMany({
      where: { id: candidate.id, state: 'dispatching', claimedAt: { lt: staleAt } },
      data: { state: 'delivery_unknown', claimedAt: null },
    })
    if (result.count === 1) settled.push(candidate)
  }
  return settled
}

export type MailboxSendActionInput = {
  clientRequestId: string
  connection: MailboxConnectionRow
  organizationId: string
  ownerUserId: string
  mail: ConnectedMailboxSendInput
}

export const dispatchMailboxSendAction = async (
  prisma: PrismaClient,
  input: MailboxSendActionInput,
  deps: ConnectedMailDeps,
): Promise<{ status: 'sent'; actionId: string; messageId: string }> => {
  const mail = prepareMailboxSend(input.mail)
  const fingerprint = mailboxSendFingerprint(mail)
  const id = randomUUID()
  const domain = input.connection.address.split('@')[1] ?? 'localhost'
  const messageId = `nessie-${id}@${domain}`
  preflightMailboxMime(input.connection, mail, messageId)
  const action = await prisma.mailboxSendAction.upsert({
    where: {
      connectionId_clientRequestId: {
        connectionId: input.connection.id, clientRequestId: input.clientRequestId,
      },
    },
    create: {
      id, organizationId: input.organizationId, ownerUserId: input.ownerUserId,
      connectionId: input.connection.id, clientRequestId: input.clientRequestId,
      contentFingerprint: fingerprint, messageId,
    },
    update: {},
  })
  if (action.ownerUserId !== input.ownerUserId) throw new ConnectedMailError('NOT_FOUND')
  if (action.contentFingerprint !== fingerprint || action.state === 'delivery_unknown') {
    throw new ConnectedMailError('DELIVERY_UNKNOWN', action.id)
  }
  if (action.state === 'dispatching') {
    const settled = await prisma.mailboxSendAction.updateMany({
      where: { id: action.id, state: 'dispatching' },
      data: { state: 'delivery_unknown', claimedAt: null },
    })
    throw new ConnectedMailError('DELIVERY_UNKNOWN', action.id, settled.count === 1)
  }
  if (action.state === 'sent') return { status: 'sent', actionId: action.id, messageId: action.messageId }
  const claimed = await prisma.mailboxSendAction.updateMany({
    where: { id: action.id, state: 'ready' }, data: { state: 'dispatching', claimedAt: new Date() },
  })
  if (claimed.count !== 1) throw new ConnectedMailError('DELIVERY_UNKNOWN', action.id)
  let endpoints
  try {
    endpoints = await mailboxEndpointsFor(prisma, input.connection, deps.encryptionSecret)
  } catch (error) {
    if (error instanceof MailboxCredentialMissingError) {
      await prisma.mailboxSendAction.updateMany({
        where: { id: action.id, state: 'dispatching' }, data: { state: 'ready', claimedAt: null },
      })
      await markMailboxNeedsReauthorization(prisma, input.connection.id, 'The email address or password was not accepted.')
      throw new ConnectedMailError('NEEDS_REAUTHORIZATION')
    }
    throw error
  }
  try {
    await (deps.sendMailbox ?? sendFromMailbox)(endpoints, {
      bcc: mail.bcc, cc: mail.cc, inReplyTo: mail.inReplyTo, messageId: action.messageId,
      references: mail.inReplyTo ? [mail.inReplyTo] : undefined,
      subject: mail.subject, text: mail.body, to: mail.to,
    }, mailboxDialOptions())
  } catch (error) {
    if (error instanceof MailboxCredentialMissingError || mailboxConnectionTestFailure(error) === 'credential_rejected') {
      await prisma.mailboxSendAction.updateMany({
        where: { id: action.id, state: 'dispatching' }, data: { state: 'ready', claimedAt: null },
      })
      await markMailboxNeedsReauthorization(prisma, input.connection.id, 'The email address or password was not accepted.')
      throw new ConnectedMailError('NEEDS_REAUTHORIZATION')
    }
    if (isDeterministicPreDataRejection(error)) {
      await prisma.mailboxSendAction.updateMany({
        where: { id: action.id, state: 'dispatching' }, data: { state: 'ready', claimedAt: null },
      })
      throw new ConnectedMailError('DELIVERY_REJECTED', action.id)
    }
    if (error instanceof SmtpError && !error.deliveryMayHaveStarted) {
      await prisma.mailboxSendAction.updateMany({
        where: { id: action.id, state: 'dispatching' }, data: { state: 'ready', claimedAt: null },
      })
      throw new ConnectedMailError('PROVIDER_FAILED', action.id)
    }
    const settled = await prisma.mailboxSendAction.updateMany({
      where: { id: action.id, state: 'dispatching' }, data: { state: 'delivery_unknown', claimedAt: null },
    })
    throw new ConnectedMailError('DELIVERY_UNKNOWN', action.id, settled.count === 1)
  }
  try {
    await prisma.mailboxSendAction.update({
      where: { id: action.id }, data: { state: 'sent', sentAt: new Date(), claimedAt: null },
    })
  } catch {
    const settled = await prisma.mailboxSendAction.updateMany({
      where: { id: action.id, state: 'dispatching' }, data: { state: 'delivery_unknown', claimedAt: null },
    })
    throw new ConnectedMailError('DELIVERY_UNKNOWN', action.id, settled.count === 1)
  }
  return { status: 'sent', actionId: action.id, messageId: action.messageId }
}

export const readMailboxSendAction = async (
  prisma: PrismaClient,
  actor: Actor,
  connectionId: string,
  actionId: string,
): Promise<{ id: string; state: 'ready' | 'dispatching' | 'sent' | 'delivery_unknown' }> => {
  await mailboxForActor(prisma, actor, connectionId)
  const action = await prisma.mailboxSendAction.findFirst({
    where: { connectionId, id: actionId, organizationId: actor.organizationId, ownerUserId: actor.userId },
    select: { id: true, state: true },
  })
  if (!action) throw new ConnectedMailError('NOT_FOUND')
  return action
}

export const sendConnectedMailboxMail = async (
  prisma: PrismaClient,
  actor: Actor,
  accountId: string,
  input: ConnectedMailboxSendInput,
  deps: ConnectedMailDeps,
): Promise<{ status: 'sent'; actionId: string; messageId: string }> => {
  const connection = await mailboxForActor(prisma, actor, accountId)
  return dispatchMailboxSendAction(prisma, {
    clientRequestId: input.idempotencyKey, connection, mail: input,
    organizationId: actor.organizationId, ownerUserId: actor.userId,
  }, deps)
}
