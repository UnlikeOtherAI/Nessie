import { Prisma, type PrismaClient } from '@prisma/client'
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
  let message
  try {
    message = await prisma.agentMailboxMessage.create({
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
  }
  catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      input.toAgentId &&
      input.correlationId
    ) {
      const existing = await prisma.agentMailboxMessage.findFirst({
        where: {
          organizationId,
          toAgentId: input.toAgentId,
          correlationId: input.correlationId,
        },
      })
      if (existing) {
        return mapMailboxMessage(existing)
      }
    }
    throw error
  }

  return mapMailboxMessage(message)
}

export const claimMailboxMessage = async (
  prisma: PrismaClient,
  organizationId: string,
  messageId: string,
): Promise<MailboxMessageRecord | null> => {
  const now = new Date()

  const claimed = await prisma.agentMailboxMessage.updateMany({
    where: {
      id: messageId,
      organizationId,
      status: 'queued',
      claimedAt: null,
      deliveredAt: null,
      visibleAt: {
        lte: now,
      },
    },
    data: {
      status: 'processing',
      claimedAt: now,
      attempts: {
        increment: 1,
      },
    },
  })

  if (claimed.count === 0) {
    return null
  }

  const message = await prisma.agentMailboxMessage.findUnique({
    where: { id: messageId },
  })
  if (!message) {
    return null
  }

  return mapMailboxMessage(message)
}

export const markMailboxMessageDelivered = async (
  prisma: PrismaClient,
  organizationId: string,
  messageId: string,
): Promise<MailboxMessageRecord | null> => {
  const delivered = await prisma.agentMailboxMessage.updateMany({
    where: {
      id: messageId,
      organizationId,
      status: 'processing',
      claimedAt: {
        not: null,
      },
      deliveredAt: null,
    },
    data: {
      status: 'delivered',
      deliveredAt: new Date(),
    },
  })

  if (delivered.count === 0) {
    return null
  }

  const message = await prisma.agentMailboxMessage.findUnique({
    where: { id: messageId },
  })
  if (!message) {
    return null
  }

  return mapMailboxMessage(message)
}
