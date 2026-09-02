import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import {
  InboundObjectTooLargeError,
  parseInboundEmail,
  resolveInboundThreading,
  shouldWakeAgent,
  type AgentMailConfig,
  type AgentMailTransport,
  type ParsedEmail,
  type SesInboundReceipt,
} from '@nessie/agent-mail'
import type { FileService, PgRealtimeTransport } from '@nessie/runtime'
import { recordConnectorUsage } from '@nessie/runtime'
import { resolveMailboxByAddress } from '@nessie/workspace-admin'
import { parseAgentId, parseRunId, parseTaskId, parseThreadId } from '@nessie/schemas'

import { enqueueRunExecution } from '../../queue.js'
import { claimThreadRunOrPend } from '../../run/thread-serialization.js'
import { buildEmailScopes, buildInboundEmailActorContext } from './actor.js'
import {
  inboundClaimKey,
  storeInboundAttachments,
  storeOversizeStub,
  type ResolvedMailbox,
} from './inbound-storage.js'

/**
 * Inbound email → stored message → (maybe) a run.
 *
 * Three properties this file exists to hold:
 *
 *  1. **Routing is the envelope, never the headers.** SES tells us who the
 *     message was actually delivered to; MIME `To:`/`Cc:` are written by the
 *     sender, omit Bcc destinations entirely, and can name another tenant's
 *     mailbox.
 *  2. **Delivery is claimed exactly once.** SES and SNS both retry. The claim
 *     is a conditional insert on the receipt id, and the wake happens in the
 *     same transaction — persist-and-wake is one decision, so a retry can
 *     never produce a second run for one message.
 *  3. **Waking the agent is structural.** Bulk, delivery reports, and mail
 *     whose SES verdicts failed are stored and readable but spend nothing.
 */

export type InboundEmailDeps = {
  prisma: PrismaClient
  realtimeTransport: PgRealtimeTransport
  files: FileService
  transport: AgentMailTransport
  config: AgentMailConfig
}

export type InboundOutcome =
  | { status: 'delivered'; emailMessageId: string; woke: boolean }
  | { status: 'duplicate' }
  | { status: 'no_mailbox' }
  | { status: 'too_large' }
  | { status: 'missing_object' }

/**
 * One receipt can name several of our addresses (a catch-all delivery, or a
 * message addressed to two agents). Each mailbox gets its own stored message
 * and its own decision, deterministically, in address order.
 */
export const processInboundReceipt = async (
  deps: InboundEmailDeps,
  receipt: SesInboundReceipt,
): Promise<InboundOutcome[]> => {
  const recipients = [...receipt.envelopeRecipients].sort()
  const mailboxes = []
  for (const address of recipients) {
    const mailbox = await resolveMailboxByAddress(deps.prisma, address)
    if (mailbox) mailboxes.push(mailbox)
  }
  if (mailboxes.length === 0) {
    // An unknown local part is dropped. Deliberately no bounce is generated:
    // replying to unroutable mail is how a deployment becomes a backscatter
    // source.
    return [{ status: 'no_mailbox' }]
  }

  if (!receipt.s3ObjectKey) return [{ status: 'missing_object' }]

  const head = await deps.transport.headInboundObject(receipt.s3ObjectKey)
  if (!head) return [{ status: 'missing_object' }]
  if (head.contentLength > deps.config.maxInboundBytes) {
    // Size is checked before the body is streamed, so an oversized message
    // cannot exhaust worker memory to be rejected.
    const outcomes: InboundOutcome[] = []
    for (const mailbox of mailboxes) {
      await storeOversizeStub(deps, receipt, mailbox, head.contentLength)
      outcomes.push({ status: 'too_large' })
    }
    return outcomes
  }

  const raw = await deps.transport.getInboundObject(receipt.s3ObjectKey)
  const parsed = await parseInboundEmail(raw, { envelopeFrom: receipt.envelopeFrom })

  const outcomes: InboundOutcome[] = []
  for (const mailbox of mailboxes) {
    outcomes.push(await deliverToMailbox(deps, receipt, parsed, mailbox))
  }
  return outcomes
}

const deliverToMailbox = async (
  deps: InboundEmailDeps,
  receipt: SesInboundReceipt,
  parsed: ParsedEmail,
  mailbox: ResolvedMailbox,
): Promise<InboundOutcome> => {
  const wake = shouldWakeAgent({
    classification: parsed.classification,
    verdicts: receipt.verdicts,
  })

  const conversationId = await resolveConversation(deps.prisma, mailbox, parsed, receipt)

  let created: { emailMessageId: string; threadId: string; runId: string | null } | null = null
  try {
    created = await deps.prisma.$transaction(async (tx) => {
      const conversation = await upsertConversation(tx, mailbox, parsed, receipt, conversationId)

      // The claim. A retried SNS delivery collides here and the whole
      // transaction — message, chat reference, run — rolls back as one.
      const emailMessage = await tx.emailMessage.create({
        data: {
          authResults: receipt.verdicts as Prisma.InputJsonValue,
          bccAddresses: [],
          ccAddresses: parsed.ccAddresses,
          classification: parsed.classification,
          conversationId: conversation.id,
          direction: 'inbound',
          envelopeRecipients: receipt.envelopeRecipients,
          fromAddress: parsed.fromAddress ?? 'unknown@invalid',
          fromName: parsed.fromName,
          htmlBody: parsed.htmlBody,
          inReplyTo: parsed.inReplyTo,
          mailboxId: mailbox.id,
          occurredAt: parsed.date ?? new Date(receipt.receivedAt),
          organizationId: mailbox.organizationId,
          receiptId: inboundClaimKey(receipt.sesMessageId, mailbox.id),
          referencesIds: parsed.references,
          replyToAddress: parsed.replyToAddress,
          rfcMessageId: parsed.rfcMessageId ?? `no-message-id-${randomUUID()}@invalid`,
          s3ObjectKey: receipt.s3ObjectKey,
          snippet: parsed.snippet,
          subject: parsed.subject,
          textBody: parsed.textBody,
          toAddresses: parsed.toAddresses,
        },
        select: { id: true },
      })

      await tx.emailConversation.update({
        data: {
          lastMessageAt: parsed.date ?? new Date(receipt.receivedAt),
          messageCount: { increment: 1 },
        },
        where: { id: conversation.id },
      })

      const runId = wake
        ? await postReferenceAndWake(tx, deps, mailbox, conversation, parsed)
        : null

      return { emailMessageId: emailMessage.id, runId, threadId: conversation.threadId }
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // Already delivered: the retry loses the claim and changes nothing.
      return { status: 'duplicate' }
    }
    throw error
  }

  // Attachments are stored after the claim commits: a duplicate delivery must
  // not double-store bytes, and a storage failure must not lose the message.
  await storeInboundAttachments(deps, mailbox, created.emailMessageId, parsed)

  await recordConnectorUsage(deps.prisma, {
    attribution: {
      actorId: mailbox.agentId,
      actorType: 'service',
      agentId: mailbox.agentId,
      channelId: mailbox.channelId,
      organizationId: mailbox.organizationId,
      systemComponent: 'agent-email.inbound',
      threadId: created.threadId,
    },
    event: {
      calls: 1,
      connectorType: 'email',
      metadata: { classification: parsed.classification, woke: wake },
      operation: 'receive',
      success: true,
      target: mailbox.address,
      unitType: 'messages',
      units: 1,
    },
  })

  if (created.runId) {
    await deps.realtimeTransport.publishWs(
      buildEmailScopes({
        agentId: mailbox.agentId,
        channelId: mailbox.channelId,
        organizationId: mailbox.organizationId,
      }),
      {
        data: {
          channelId: mailbox.channelId,
          mailboxId: mailbox.id,
          threadId: created.threadId,
        },
        event: 'email.received',
      },
    )
  }

  return { emailMessageId: created.emailMessageId, status: 'delivered', woke: wake }
}

/**
 * Which conversation this message joins. Read outside the write transaction so
 * the candidate scan does not hold row locks; a race here at worst starts a
 * second conversation, which is recoverable, whereas a lock-order inversion in
 * the claim path is not.
 */
const resolveConversation = async (
  prisma: PrismaClient,
  mailbox: ResolvedMailbox,
  parsed: ParsedEmail,
  receipt: SesInboundReceipt,
): Promise<string | null> => {
  const lookupIds = [parsed.inReplyTo, ...parsed.references].filter(
    (id): id is string => Boolean(id),
  )
  if (lookupIds.length === 0) return null
  void receipt

  const candidates = await prisma.emailMessage.findMany({
    select: { conversationId: true, occurredAt: true, rfcMessageId: true },
    where: { mailboxId: mailbox.id, rfcMessageId: { in: lookupIds } },
    orderBy: { occurredAt: 'asc' },
  })
  const decision = resolveInboundThreading({
    candidates: candidates.map((row) => ({
      conversationId: row.conversationId,
      rfcMessageId: row.rfcMessageId,
    })),
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
  })
  return decision.kind === 'existing' ? decision.conversationId : null
}

const upsertConversation = async (
  tx: Prisma.TransactionClient,
  mailbox: ResolvedMailbox,
  parsed: ParsedEmail,
  receipt: SesInboundReceipt,
  conversationId: string | null,
): Promise<{ id: string; threadId: string }> => {
  if (conversationId) {
    const existing = await tx.emailConversation.findFirst({
      select: { id: true, threadId: true },
      where: { id: conversationId, mailboxId: mailbox.id },
    })
    if (existing) return existing
  }

  // A new conversation gets its own thread in the mailbox's backing channel —
  // that thread is where the run reports and any approval gate will live.
  const thread = await tx.thread.create({
    data: { channelId: mailbox.channelId, title: parsed.subject },
    select: { id: true },
  })
  const participants = [
    parsed.fromAddress,
    ...parsed.toAddresses,
    ...parsed.ccAddresses,
  ].filter((address): address is string => Boolean(address))

  return tx.emailConversation.create({
    data: {
      lastMessageAt: parsed.date ?? new Date(receipt.receivedAt),
      mailboxId: mailbox.id,
      messageCount: 0,
      organizationId: mailbox.organizationId,
      participants: [...new Set(participants)],
      subject: parsed.subject,
      threadId: thread.id,
    },
    select: { id: true, threadId: true },
  })
}

/**
 * The compact, server-authored reference message plus the run claim.
 *
 * The reference message is what makes the correspondence visible in chat and
 * gives the run something to answer; the email itself is loaded into the run's
 * context from the store, never from this message.
 */
const postReferenceAndWake = async (
  tx: Prisma.TransactionClient,
  deps: InboundEmailDeps,
  mailbox: ResolvedMailbox,
  conversation: { id: string; threadId: string },
  parsed: ParsedEmail,
): Promise<string | null> => {
  const sender = parsed.fromName
    ? `${parsed.fromName} <${parsed.fromAddress ?? 'unknown'}>`
    : parsed.fromAddress ?? 'unknown sender'
  const content = `📧 New email from ${sender}\nSubject: ${parsed.subject}`

  const promptMessage = await tx.message.create({
    data: {
      content,
      metadata: {
        emailInbound: {
          conversationId: conversation.id,
          mailboxId: mailbox.id,
        },
      } as Prisma.InputJsonValue,
      role: 'user',
      threadId: conversation.threadId,
    },
    select: { id: true },
  })

  const baseActorContext = buildInboundEmailActorContext({
    agentId: mailbox.agentId,
    channelId: mailbox.channelId,
    organizationId: mailbox.organizationId,
    threadId: conversation.threadId,
  })

  // The same per-(agent, thread) claim chat replies and trigger fires use: a
  // second email arriving mid-run pends for the batched follow-up instead of
  // starting a concurrent run in the same conversation.
  const claim = await claimThreadRunOrPend(tx, {
    agentId: mailbox.agentId,
    pending: {
      actorContext: baseActorContext,
      channelId: mailbox.channelId,
      // Never a live human turn: nobody is watching, so the run's unattended
      // floors apply and it may not open new outbound correspondence.
      interactive: false,
      messageId: promptMessage.id,
    },
    threadId: conversation.threadId,
  })
  if (claim !== 'claimed') return null

  const run = await tx.run.create({
    data: {
      agentId: mailbox.agentId,
      status: 'pending',
      threadId: conversation.threadId,
      triggerMessageId: promptMessage.id,
    },
    select: { id: true },
  })
  const task = await tx.task.create({
    data: {
      agentId: mailbox.agentId,
      organizationId: mailbox.organizationId,
      purpose: `Email: ${parsed.subject}`.slice(0, 200),
      runId: run.id,
      status: 'inbox',
    },
    select: { id: true },
  })

  await enqueueRunExecution(
    tx,
    {
      actorContext: buildInboundEmailActorContext({
        agentId: mailbox.agentId,
        channelId: mailbox.channelId,
        organizationId: mailbox.organizationId,
        taskId: task.id,
        threadId: conversation.threadId,
      }),
      agentId: parseAgentId(mailbox.agentId),
      interactive: false,
      messageId: promptMessage.id,
      promptOverride: content,
      runId: parseRunId(run.id),
      taskId: parseTaskId(task.id),
      threadId: parseThreadId(conversation.threadId),
    },
    `agent-email:${conversation.id}:${promptMessage.id}`,
  )
  void deps
  return run.id
}

export { InboundObjectTooLargeError }
