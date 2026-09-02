import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import {
  buildOutboundMime,
  replySubject,
  type AgentMailConfig,
  type AgentMailTransport,
} from '@nessie/agent-mail'
import { recordConnectorUsage } from '@nessie/runtime'

/**
 * Outbound send — crash-safe by construction.
 *
 * The dangerous window is between SES accepting a message and us recording
 * that it did. A naive retry there sends the same mail twice, which is not
 * recoverable: the recipient has both copies. So the row is written `queued`
 * first, dispatch claims it with a conditional `queued → sending` update, and a
 * worker death after the SES call leaves `sending`, which resolves to
 * `delivery_unknown` and is **never** replayed. The generated `Message-ID` is
 * persisted with the queued row, so a legitimate retry of a call that provably
 * did not reach SES reuses one identity rather than minting a second.
 */

export type OutboundDeps = {
  prisma: PrismaClient
  transport: AgentMailTransport
  config: AgentMailConfig
}

export type QueueOutboundInput = {
  mailboxId: string
  organizationId: string
  conversationId?: string | null
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string | null
  text: string
  runId?: string | null
  approvalId?: string | null
}

export class SuppressedRecipientError extends Error {
  constructor(readonly addresses: string[]) {
    super(
      `Refused: ${addresses.join(', ')} previously hard-bounced or reported this deployment `
      + 'as spam. Sending again would damage delivery for every mailbox here.',
    )
    this.name = 'SuppressedRecipientError'
  }
}

export class SendRateLimitedError extends Error {
  constructor(readonly limit: number) {
    super(`This mailbox has already sent ${limit} messages in the last hour.`)
    this.name = 'SendRateLimitedError'
  }
}

/**
 * Refuse before anything is written. Suppression is deployment-wide because SES
 * reputation is per account — one organisation's bounces are every
 * organisation's deliverability.
 */
export const assertRecipientsSendable = async (
  prisma: PrismaClient,
  recipients: string[],
): Promise<void> => {
  const suppressed = await prisma.emailSuppression.findMany({
    select: { address: true },
    where: { address: { in: recipients.map((address) => address.toLowerCase()) } },
  })
  if (suppressed.length > 0) {
    throw new SuppressedRecipientError(suppressed.map((row) => row.address))
  }
}

export const assertWithinSendRate = async (
  prisma: PrismaClient,
  mailboxId: string,
  limit: number,
): Promise<void> => {
  const since = new Date(Date.now() - 60 * 60 * 1000)
  const sent = await prisma.emailMessage.count({
    where: {
      createdAt: { gte: since },
      direction: 'outbound',
      mailboxId,
    },
  })
  if (sent >= limit) throw new SendRateLimitedError(limit)
}

/**
 * Write the outbound row as `queued` and return it. Threading headers come from
 * the conversation's newest inbound message so the recipient's client threads
 * the reply where they expect it.
 */
export const queueOutboundEmail = async (
  deps: OutboundDeps,
  input: QueueOutboundInput,
): Promise<{ id: string; conversationId: string; rfcMessageId: string }> => {
  const mailbox = await deps.prisma.agentMailbox.findFirst({
    select: { address: true, channelId: true, displayName: true, id: true },
    where: { id: input.mailboxId, organizationId: input.organizationId, retiredAt: null },
  })
  if (!mailbox) throw new Error('Mailbox not found.')

  const rfcMessageId = `${randomUUID()}@${deps.config.domain}`

  return deps.prisma.$transaction(async (tx) => {
    const { conversationId, subject, inReplyTo, references } = await resolveOutboundThread(
      tx,
      input,
      mailbox,
    )

    const created = await tx.emailMessage.create({
      data: {
        approvalId: input.approvalId ?? null,
        bccAddresses: input.bcc ?? [],
        ccAddresses: input.cc ?? [],
        conversationId,
        deliveryState: 'queued',
        direction: 'outbound',
        envelopeRecipients: [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])],
        fromAddress: mailbox.address,
        fromName: mailbox.displayName,
        inReplyTo,
        mailboxId: mailbox.id,
        occurredAt: new Date(),
        organizationId: input.organizationId,
        referencesIds: references,
        rfcMessageId,
        sentByRunId: input.runId ?? null,
        snippet: input.text.replace(/\s+/g, ' ').trim().slice(0, 240),
        subject,
        textBody: input.text,
        toAddresses: input.to,
      },
      select: { id: true },
    })

    await tx.emailConversation.update({
      data: { lastMessageAt: new Date(), messageCount: { increment: 1 } },
      where: { id: conversationId },
    })

    return { conversationId, id: created.id, rfcMessageId }
  })
}

const resolveOutboundThread = async (
  tx: Prisma.TransactionClient,
  input: QueueOutboundInput,
  mailbox: { channelId: string; id: string },
): Promise<{
  conversationId: string
  subject: string
  inReplyTo: string | null
  references: string[]
}> => {
  if (input.conversationId) {
    const conversation = await tx.emailConversation.findFirst({
      select: { id: true, subject: true },
      where: { id: input.conversationId, mailboxId: mailbox.id },
    })
    if (conversation) {
      const newest = await tx.emailMessage.findFirst({
        orderBy: { occurredAt: 'desc' },
        select: { referencesIds: true, rfcMessageId: true },
        where: { conversationId: conversation.id, direction: 'inbound' },
      })
      const priorReferences = Array.isArray(newest?.referencesIds)
        ? (newest?.referencesIds as string[])
        : []
      return {
        conversationId: conversation.id,
        inReplyTo: newest?.rfcMessageId ?? null,
        references: newest?.rfcMessageId
          ? [...priorReferences, newest.rfcMessageId].slice(-20)
          : priorReferences,
        subject: input.subject?.trim() || replySubject(conversation.subject),
      }
    }
  }

  // A new outbound conversation gets its own thread, so the correspondence is
  // visible in the mailbox channel exactly like an inbound one.
  const subject = input.subject?.trim() || '(no subject)'
  const thread = await tx.thread.create({
    data: { channelId: mailbox.channelId, title: subject },
    select: { id: true },
  })
  const conversation = await tx.emailConversation.create({
    data: {
      lastMessageAt: new Date(),
      mailboxId: mailbox.id,
      messageCount: 0,
      organizationId: input.organizationId,
      participants: [...new Set([...input.to, ...(input.cc ?? [])])],
      subject,
      threadId: thread.id,
    },
    select: { id: true },
  })
  return { conversationId: conversation.id, inReplyTo: null, references: [], subject }
}

export type DispatchResult =
  | { status: 'sent'; sesMessageId: string }
  | { status: 'already_claimed' }
  | { status: 'unknown' }

/**
 * Claim the queued row and hand it to SES. Exactly one caller can win the
 * `queued → sending` update, so a duplicate dispatch is impossible; an
 * ambiguous SES outcome parks at `delivery_unknown` for a person to judge
 * rather than being retried into a duplicate send.
 */
export const dispatchQueuedEmail = async (
  deps: OutboundDeps,
  emailMessageId: string,
): Promise<DispatchResult> => {
  const claimed = await deps.prisma.emailMessage.updateMany({
    data: { deliveryState: 'sending' },
    where: { deliveryState: 'queued', id: emailMessageId },
  })
  if (claimed.count === 0) return { status: 'already_claimed' }

  const message = await deps.prisma.emailMessage.findUnique({
    select: {
      bccAddresses: true,
      ccAddresses: true,
      conversationId: true,
      fromAddress: true,
      fromName: true,
      inReplyTo: true,
      mailbox: { select: { agentId: true, channelId: true, id: true } },
      organizationId: true,
      referencesIds: true,
      rfcMessageId: true,
      sentByRunId: true,
      subject: true,
      textBody: true,
      toAddresses: true,
    },
    where: { id: emailMessageId },
  })
  if (!message) return { status: 'already_claimed' }

  const asList = (value: Prisma.JsonValue): string[] =>
    Array.isArray(value) ? (value as string[]) : []
  const to = asList(message.toAddresses)
  const cc = asList(message.ccAddresses)
  const bcc = asList(message.bccAddresses)

  const raw = buildOutboundMime({
    bcc,
    cc,
    fromAddress: message.fromAddress,
    fromName: message.fromName,
    inReplyTo: message.inReplyTo,
    messageId: message.rfcMessageId,
    references: asList(message.referencesIds),
    subject: message.subject,
    text: message.textBody,
    to,
  })

  try {
    const { sesMessageId } = await deps.transport.sendRaw({
      destinations: [...to, ...cc, ...bcc],
      fromAddress: message.fromAddress,
      rawMessage: raw,
    })
    await deps.prisma.emailMessage.update({
      data: { deliveryState: 'sent', sesMessageId },
      where: { id: emailMessageId },
    })
    await recordConnectorUsage(deps.prisma, {
      attribution: {
        actorId: message.mailbox.agentId,
        actorType: 'agent',
        agentId: message.mailbox.agentId,
        channelId: message.mailbox.channelId,
        organizationId: message.organizationId,
        runId: message.sentByRunId,
      },
      event: {
        calls: 1,
        connectorType: 'email',
        operation: 'send',
        success: true,
        target: message.fromAddress,
        unitType: 'recipients',
        units: to.length + cc.length + bcc.length,
      },
    })
    return { sesMessageId, status: 'sent' }
  } catch (error) {
    // SES may or may not have accepted. Park it: a person can see the state and
    // decide, which is strictly better than silently sending twice.
    await deps.prisma.emailMessage.update({
      data: { deliveryState: 'delivery_unknown' },
      where: { id: emailMessageId },
    })
    console.error('[agent-email.outbound] send outcome unknown', { emailMessageId, error })
    return { status: 'unknown' }
  }
}
