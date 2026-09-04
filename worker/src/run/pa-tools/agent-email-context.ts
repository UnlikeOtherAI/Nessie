import type { PrismaClient } from '@prisma/client'
import {
  createAgentMailTransport,
  normalizeAddress,
  replySubject,
  resolveAgentMailReadiness,
  type AgentMailConfig,
  type AgentMailTransport,
} from '@nessie/agent-mail'
import { loadConfig } from '@nessie/config'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'

/**
 * Mailbox resolution and reply addressing for the email tools.
 *
 * Split out of the handlers because addressing a reply is a decision with real
 * rules — who is on the thread, `Reply-To` over `From`, the agent's own address
 * never echoed back — and those rules deserve their own tests.
 */

export type RunMailbox = {
  id: string
  address: string
  displayName: string | null
  channelId: string
  sendPolicy: 'approval' | 'auto_reply' | 'auto'
  config: AgentMailConfig
  transport: AgentMailTransport
}

let cachedConfig: AgentMailConfig | null = null
let cachedTransport: AgentMailTransport | null = null

const mailDeployment = (): { config: AgentMailConfig; transport: AgentMailTransport } => {
  if (!cachedConfig || !cachedTransport) {
    const readiness = resolveAgentMailReadiness(loadConfig().email)
    if (!readiness.ready) {
      throw new Error(readiness.reason)
    }
    cachedConfig = readiness.config
    cachedTransport = createAgentMailTransport(readiness.config)
  }
  return { config: cachedConfig, transport: cachedTransport }
}

export const loadAgentMailboxForRun = async (
  prisma: PrismaClient,
  input: { agentId: string; organizationId: string },
): Promise<RunMailbox | null> => {
  const mailbox = await prisma.agentMailbox.findFirst({
    select: {
      address: true,
      channelId: true,
      displayName: true,
      id: true,
      sendPolicy: true,
    },
    where: {
      agentId: input.agentId,
      organizationId: input.organizationId,
      retiredAt: null,
      status: 'active',
    },
  })
  if (!mailbox) return null
  const deployment = mailDeployment()
  return {
    ...mailbox,
    config: deployment.config,
    sendPolicy: mailbox.sendPolicy as RunMailbox['sendPolicy'],
    transport: deployment.transport,
  }
}

export type ResolvedRecipients = {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  conversationId: string | null
  isReply: boolean
}

const asAddressList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (typeof entry === 'string' ? normalizeAddress(entry) : null))
    .filter((entry): entry is string => Boolean(entry))
}

/**
 * Where a send goes.
 *
 * With no explicit `to` and an email conversation in scope, this is a reply:
 * recipients come from the newest inbound message (honouring `Reply-To` over
 * `From`, which is what that header is for), everyone else on the thread is
 * carried on Cc, and the subject is derived rather than invented. The mailbox's
 * own address is always removed — replying to yourself is a loop.
 */
type RecipientResolutionContext = Pick<BuiltinToolRuntimeContext, 'prisma' | 'runContext'>
type RecipientMailbox = Pick<RunMailbox, 'address' | 'id'>

export const resolveOutboundRecipients = async (
  context: RecipientResolutionContext,
  mailbox: RecipientMailbox,
  args: Record<string, unknown>,
): Promise<ResolvedRecipients> => {
  const explicitTo = asAddressList(args.to)
  const explicitCc = asAddressList(args.cc)
  const explicitBcc = asAddressList(args.bcc)
  const subjectArg = typeof args.subject === 'string' ? args.subject.trim() : ''
  const conversationId = context.runContext?.emailConversationId ?? null

  if (explicitTo.length > 0 || !conversationId) {
    if (explicitTo.length === 0) {
      throw new Error('Give at least one recipient in `to`.')
    }
    if (!subjectArg) {
      throw new Error('A new email conversation needs a subject.')
    }
    return {
      bcc: explicitBcc,
      cc: explicitCc,
      // A brand-new outbound conversation, even from inside a mailbox thread.
      conversationId: null,
      isReply: false,
      subject: subjectArg,
      to: explicitTo.filter((address) => address !== mailbox.address),
    }
  }

  const conversation = await context.prisma.emailConversation.findFirst({
    select: { id: true, subject: true },
    where: { id: conversationId, mailboxId: mailbox.id },
  })
  if (!conversation) {
    throw new Error('That conversation is not in this mailbox.')
  }

  const newest = await context.prisma.emailMessage.findFirst({
    orderBy: { occurredAt: 'desc' },
    select: {
      ccAddresses: true,
      fromAddress: true,
      replyToAddress: true,
      toAddresses: true,
    },
    where: { conversationId: conversation.id, direction: 'inbound' },
  })
  if (!newest) {
    throw new Error(
      'This conversation has no incoming message to reply to. Give `to` and `subject` to '
      + 'start a new one.',
    )
  }

  const primary = newest.replyToAddress ?? newest.fromAddress
  const others = [
    ...(Array.isArray(newest.toAddresses) ? (newest.toAddresses as string[]) : []),
    ...(Array.isArray(newest.ccAddresses) ? (newest.ccAddresses as string[]) : []),
    ...explicitCc,
  ]

  const cc = [...new Set(others)].filter(
    (address) => address !== mailbox.address && address !== primary,
  )

  return {
    bcc: explicitBcc,
    cc,
    conversationId: conversation.id,
    isReply: true,
    subject: subjectArg || replySubject(conversation.subject),
    to: [primary],
  }
}

/** Reset the memoized deployment client. Tests only. */
export const resetMailDeploymentCache = (): void => {
  cachedConfig = null
  cachedTransport = null
}
