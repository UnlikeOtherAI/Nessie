import type { Prisma, PrismaClient } from '@prisma/client'
import {
  buildPage,
  decodeKeysetCursor,
  encodeKeysetCursor,
  type AgentMailboxRecord,
  type EmailConversationRecord,
  type EmailMessageRecord,
  type PaginationMeta,
} from '@nessie/schemas'
import { isAgentVisibleToUser, type MailboxRecord } from '@nessie/team-admin'

/**
 * Reads for the mailbox surface.
 *
 * Entitlement is the shared agent-visibility predicate: whoever can see the
 * agent can read its correspondence. Deliberately not "any org member" and
 * deliberately not the session's project/team — narrowing by ambient context is
 * the mistake Rule zero names, and widening past agent visibility would let a
 * member read mail for an agent `GET /api/agents` would withhold.
 */

export const presentMailbox = (mailbox: MailboxRecord): AgentMailboxRecord => ({
  address: mailbox.address,
  agentId: mailbox.agentId,
  channelId: mailbox.channelId,
  createdAt: mailbox.createdAt.toISOString(),
  displayName: mailbox.displayName,
  domain: mailbox.domain,
  id: mailbox.id,
  sendPolicy: mailbox.sendPolicy as AgentMailboxRecord['sendPolicy'],
  status: mailbox.status as AgentMailboxRecord['status'],
  statusReason: mailbox.statusReason,
})

export const readableMailboxForAgent = async (
  prisma: PrismaClient,
  input: { agentId: string; organizationId: string; userId: string },
): Promise<MailboxRecord | null> => {
  const visible = await isAgentVisibleToUser(
    prisma,
    input.userId,
    input.organizationId,
    input.agentId,
  )
  if (!visible) return null

  const mailbox = await prisma.agentMailbox.findFirst({
    select: {
      address: true,
      agentId: true,
      channelId: true,
      createdAt: true,
      displayName: true,
      id: true,
      sendPolicy: true,
      status: true,
      statusReason: true,
    },
    where: {
      agentId: input.agentId,
      organizationId: input.organizationId,
      retiredAt: null,
    },
  })
  if (!mailbox) return null
  return { ...mailbox, domain: mailbox.address.slice(mailbox.address.lastIndexOf('@') + 1) }
}

type ConversationRow = {
  id: string
  createdAt: Date
  subject: string
  participants: unknown
  threadId: string
  lastMessageAt: Date
  messageCount: number
}

const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

export const listMailboxConversations = async (
  prisma: PrismaClient,
  input: {
    mailboxId: string
    limit: number
    cursor?: string
    filter: 'all' | 'inbox' | 'sent'
  },
): Promise<{ items: EmailConversationRecord[]; pagination: PaginationMeta }> => {
  const cursor = decodeKeysetCursor(input.cursor)

  // Inbox / Sent narrow to conversations that contain at least one message in
  // that direction — a reply thread legitimately appears under both.
  const where: Prisma.EmailConversationWhereInput = {
    mailboxId: input.mailboxId,
    ...(cursor ? { lastMessageAt: { lt: cursor.createdAt } } : {}),
    ...(input.filter === 'all'
      ? {}
      : {
          messages: {
            some: { direction: input.filter === 'inbox' ? 'inbound' : 'outbound' },
          },
        }),
  }

  const rows = await prisma.emailConversation.findMany({
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    select: {
      createdAt: true,
      id: true,
      lastMessageAt: true,
      messageCount: true,
      participants: true,
      subject: true,
      threadId: true,
    },
    take: input.limit + 1,
    where,
  })

  const page = buildPage<ConversationRow & { createdAt: Date }>({
    hasCursor: Boolean(cursor),
    limit: input.limit,
    rows: rows.map((row) => ({ ...row, createdAt: row.lastMessageAt })),
    total: await prisma.emailConversation.count({ where: { mailboxId: input.mailboxId } }),
  })

  const conversationIds = page.data.map((row) => row.id)
  const [snippets, bounced, pendingApprovals] = await Promise.all([
    prisma.emailMessage.findMany({
      distinct: ['conversationId'],
      orderBy: { occurredAt: 'desc' },
      select: { conversationId: true, snippet: true },
      where: { conversationId: { in: conversationIds } },
    }),
    prisma.emailMessage.findMany({
      distinct: ['conversationId'],
      select: { conversationId: true },
      where: {
        conversationId: { in: conversationIds },
        deliveryState: { in: ['bounced', 'complained', 'delivery_unknown'] },
      },
    }),
    // Chips are DERIVED from live rows — never a second mutable copy of the
    // approval's own state on the conversation.
    prisma.approvalRequest.findMany({
      select: { run: { select: { thread: { select: { emailConversation: { select: { id: true } } } } } } },
      where: {
        run: { thread: { emailConversation: { id: { in: conversationIds } } } },
        status: 'pending',
      },
    }),
  ])

  const snippetByConversation = new Map(
    snippets.map((row) => [row.conversationId, row.snippet]),
  )
  const bouncedSet = new Set(bounced.map((row) => row.conversationId))
  const awaitingSet = new Set(
    pendingApprovals
      .map((row) => row.run?.thread?.emailConversation?.id)
      .filter((id): id is string => Boolean(id)),
  )

  return {
    items: page.data.map((row) => ({
      awaitingApproval: awaitingSet.has(row.id),
      hasBounce: bouncedSet.has(row.id),
      id: row.id,
      lastMessageAt: row.lastMessageAt.toISOString(),
      messageCount: row.messageCount,
      participants: asStringList(row.participants),
      snippet: snippetByConversation.get(row.id) ?? '',
      subject: row.subject,
      threadId: row.threadId,
    })),
    pagination: page.meta,
  }
}

export const listConversationMessages = async (
  prisma: PrismaClient,
  input: { conversationId: string; mailboxId: string },
): Promise<EmailMessageRecord[] | null> => {
  // The mailbox gate alone is not enough: a conversation id is a global UUID,
  // so the pair is re-checked here and an unreadable one is shaped exactly like
  // an absent one at the route.
  const conversation = await prisma.emailConversation.findFirst({
    select: { id: true },
    where: { id: input.conversationId, mailboxId: input.mailboxId },
  })
  if (!conversation) return null

  const messages = await prisma.emailMessage.findMany({
    orderBy: { occurredAt: 'asc' },
    select: {
      ccAddresses: true,
      classification: true,
      deliveryState: true,
      direction: true,
      fromAddress: true,
      fromName: true,
      htmlBody: true,
      id: true,
      occurredAt: true,
      snippet: true,
      subject: true,
      textBody: true,
      toAddresses: true,
    },
    where: { conversationId: input.conversationId },
  })

  const attachments = await prisma.attachment.findMany({
    select: { emailMessageId: true, filename: true, id: true, mime: true, sizeBytes: true },
    where: { emailMessageId: { in: messages.map((message) => message.id) } },
  })
  const byMessage = new Map<string, typeof attachments>()
  for (const attachment of attachments) {
    if (!attachment.emailMessageId) continue
    const list = byMessage.get(attachment.emailMessageId) ?? []
    list.push(attachment)
    byMessage.set(attachment.emailMessageId, list)
  }

  return messages.map((message) => ({
    attachments: (byMessage.get(message.id) ?? []).map((attachment) => ({
      filename: attachment.filename,
      id: attachment.id,
      mime: attachment.mime,
      // BigInt is serialized as a string at every API boundary.
      sizeBytes: attachment.sizeBytes.toString(),
    })),
    ccAddresses: asStringList(message.ccAddresses),
    classification: message.classification,
    deliveryState: message.deliveryState,
    direction: message.direction,
    fromAddress: message.fromAddress,
    fromName: message.fromName,
    htmlBody: message.htmlBody,
    id: message.id,
    occurredAt: message.occurredAt.toISOString(),
    snippet: message.snippet,
    subject: message.subject,
    textBody: message.textBody,
    toAddresses: asStringList(message.toAddresses),
  }))
}

export { encodeKeysetCursor }
