import type { PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
} from '@nessie/schemas'
import type { MailboxMessageRecord } from '../contracts.js'
import { parseOptional } from './contract-helpers.js'

const mapMailboxMessage = (message: {
  attempts: number
  body: string
  channelId: string | null
  claimedAt: Date | null
  correlationId: string | null
  createdAt: Date
  deliveredAt: Date | null
  fromAgentId: string | null
  id: string
  organizationId: string
  planId: string | null
  planStepId: string | null
  status: 'dead_letter' | 'delivered' | 'processing' | 'queued'
  subject: string | null
  toAgentId: string | null
  updatedAt: Date
  visibleAt: Date
}): MailboxMessageRecord => ({
  id: message.id,
  organizationId: parseOrganizationId(message.organizationId),
  planId: message.planId ?? undefined,
  planStepId: message.planStepId ?? undefined,
  fromAgentId: parseOptional(message.fromAgentId, parseAgentId),
  toAgentId: parseOptional(message.toAgentId, parseAgentId),
  channelId: parseOptional(message.channelId, parseChannelId),
  subject: message.subject ?? undefined,
  body: message.body,
  correlationId: message.correlationId ?? undefined,
  status: message.status,
  attempts: message.attempts,
  visibleAt: message.visibleAt.toISOString(),
  claimedAt: message.claimedAt?.toISOString(),
  deliveredAt: message.deliveredAt?.toISOString(),
  createdAt: message.createdAt.toISOString(),
  updatedAt: message.updatedAt.toISOString(),
})

export const listMailboxMessages = async (
  prisma: PrismaClient,
  organizationId: string,
  input: {
    planId?: string
    toAgentId?: string
  },
): Promise<MailboxMessageRecord[]> => {
  const messages = await prisma.agentMailboxMessage.findMany({
    where: {
      organizationId,
      ...(input.planId ? { planId: input.planId } : {}),
      ...(input.toAgentId ? { toAgentId: input.toAgentId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
  })

  return messages.map(mapMailboxMessage)
}

export const createMailboxMessage = async (
  prisma: PrismaClient,
  organizationId: string,
  input: {
    body: string
    channelId?: string
    correlationId?: string
    fromAgentId?: string
    planId?: string
    planStepId?: string
    subject?: string
    toAgentId?: string
  },
): Promise<MailboxMessageRecord> => {
  const message = await prisma.agentMailboxMessage.create({
    data: {
      organizationId,
      planId: input.planId,
      planStepId: input.planStepId,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      channelId: input.channelId,
      subject: input.subject,
      body: input.body,
      correlationId: input.correlationId,
    },
  })

  return mapMailboxMessage(message)
}

export const markMailboxMessageDelivered = async (
  prisma: PrismaClient,
  organizationId: string,
  messageId: string,
): Promise<MailboxMessageRecord | null> => {
  const message = await prisma.agentMailboxMessage.findFirst({
    where: {
      id: messageId,
      organizationId,
    },
    select: { id: true },
  })
  if (!message) {
    return null
  }

  const delivered = await prisma.agentMailboxMessage.update({
    where: { id: messageId },
    data: {
      status: 'delivered',
      deliveredAt: new Date(),
      claimedAt: new Date(),
      attempts: {
        increment: 1,
      },
    },
  })

  return mapMailboxMessage(delivered)
}
