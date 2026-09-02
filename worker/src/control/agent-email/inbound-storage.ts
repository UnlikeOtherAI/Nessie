import { Readable } from 'node:stream'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { AgentMailConfig, ParsedEmail, SesInboundReceipt } from '@nessie/agent-mail'
import type { FileService } from '@nessie/runtime'

/**
 * The byte-handling half of inbound email: stored MIME parts, and the stub row
 * that stands in for a message too large to import.
 *
 * Both are deliberately outside the claim transaction in `inbound.ts`. A
 * duplicate delivery must not double-store bytes, and a storage failure must
 * not cost us the message — a mail with an unstorable attachment is still mail
 * worth reading.
 */

export type ResolvedMailbox = {
  id: string
  organizationId: string
  agentId: string
  channelId: string
  address: string
  sendPolicy: string
}

/**
 * One SES message can reach several of our mailboxes (a catch-all delivery, or
 * one addressed to two agents), so the per-mailbox claim key is the pair.
 */
export const inboundClaimKey = (sesMessageId: string, mailboxId: string): string =>
  `${sesMessageId}:${mailboxId}`

export const storeInboundAttachments = async (
  deps: { prisma: PrismaClient; files: FileService },
  mailbox: ResolvedMailbox,
  emailMessageId: string,
  parsed: ParsedEmail,
): Promise<void> => {
  if (parsed.attachments.length === 0) return

  const channel = await deps.prisma.channel.findUnique({
    select: { projectId: true, teamId: true },
    where: { id: mailbox.channelId },
  })

  for (const attachment of parsed.attachments) {
    try {
      await deps.files.store({
        attribution: {
          actorId: mailbox.agentId,
          actorType: 'service',
          agentId: mailbox.agentId,
          organizationId: mailbox.organizationId,
          systemComponent: 'agent-email.inbound',
        },
        body: Readable.from(attachment.content),
        emailMessageId,
        filename: attachment.filename,
        mime: attachment.contentType,
        organizationId: mailbox.organizationId,
        // Matches the FileService `deriveScope` email arm, so a later delete
        // nets against the same bucket.
        scope: channel ? { projectId: channel.projectId, teamId: channel.teamId } : undefined,
        // The sender is not a local principal, so nothing here is "uploaded by"
        // anyone: the mailbox channel alone decides who may read these bytes.
        uploaderId: null,
      })
    } catch (error) {
      console.error('[agent-email.inbound] attachment store failed', {
        emailMessageId,
        error,
        filename: attachment.filename,
      })
    }
  }
}

/**
 * An oversized message is registered rather than silently dropped: someone
 * scrolling the mailbox sees that something arrived and why it was not read.
 */
export const storeOversizeStub = async (
  deps: { prisma: PrismaClient; config: AgentMailConfig },
  receipt: SesInboundReceipt,
  mailbox: ResolvedMailbox,
  sizeBytes: number,
): Promise<void> => {
  const subject = '(oversized message)'
  try {
    await deps.prisma.$transaction(async (tx) => {
      const thread = await tx.thread.create({
        data: { channelId: mailbox.channelId, title: subject },
        select: { id: true },
      })
      const conversation = await tx.emailConversation.create({
        data: {
          lastMessageAt: new Date(receipt.receivedAt),
          mailboxId: mailbox.id,
          messageCount: 1,
          organizationId: mailbox.organizationId,
          participants: receipt.envelopeFrom ? [receipt.envelopeFrom] : [],
          subject,
          threadId: thread.id,
        },
        select: { id: true },
      })
      await tx.emailMessage.create({
        data: {
          // Classified bulk so it can never wake a run.
          classification: 'bulk',
          conversationId: conversation.id,
          direction: 'inbound',
          envelopeRecipients: receipt.envelopeRecipients,
          fromAddress: receipt.envelopeFrom ?? 'unknown@invalid',
          mailboxId: mailbox.id,
          occurredAt: new Date(receipt.receivedAt),
          organizationId: mailbox.organizationId,
          receiptId: inboundClaimKey(receipt.sesMessageId, mailbox.id),
          rfcMessageId: `oversize-${receipt.sesMessageId}@invalid`,
          s3ObjectKey: receipt.s3ObjectKey,
          snippet: `A ${Math.round(sizeBytes / 1024 / 1024)} MB message was not imported.`,
          subject,
          textBody:
            `This message was ${sizeBytes} bytes, over this deployment's `
            + `${deps.config.maxInboundBytes}-byte limit, so its content was not imported.`,
          toAddresses: [mailbox.address],
        },
      })
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return
    throw error
  }
}
