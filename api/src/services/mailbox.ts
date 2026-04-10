import { Prisma, type PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseThreadId,
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
  workflowRunId: string | null
  workflowStepRunId: string | null
  status: 'dead_letter' | 'delivered' | 'processing' | 'queued'
  subject: string | null
  threadId: string | null
  toAgentId: string | null
  updatedAt: Date
  visibleAt: Date
}): MailboxMessageRecord => ({
  id: message.id,
  organizationId: parseOrganizationId(message.organizationId),
  planId: message.planId ?? undefined,
  planStepId: message.planStepId ?? undefined,
  workflowRunId: message.workflowRunId ?? undefined,
  workflowStepRunId: message.workflowStepRunId ?? undefined,
  fromAgentId: parseOptional(message.fromAgentId, parseAgentId),
  toAgentId: parseOptional(message.toAgentId, parseAgentId),
  channelId: parseOptional(message.channelId, parseChannelId),
  threadId: parseOptional(message.threadId, parseThreadId),
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
    workflowRunId?: string
    workflowStepRunId?: string
    subject?: string
    threadId?: string
    toAgentId?: string
  },
): Promise<MailboxMessageRecord> => {
  let resolvedChannelId = input.channelId
  if (input.threadId) {
    const thread = await prisma.thread.findUnique({
      where: { id: input.threadId },
      select: {
        channel: {
          select: {
            organizationId: true,
          },
        },
        channelId: true,
      },
    })

    if (!thread || thread.channel.organizationId !== organizationId) {
      throw new Error('MAILBOX_THREAD_NOT_FOUND')
    }
    if (resolvedChannelId && resolvedChannelId !== thread.channelId) {
      throw new Error('MAILBOX_THREAD_CHANNEL_MISMATCH')
    }

    resolvedChannelId = thread.channelId
  }

  let message
  try {
    message = await prisma.agentMailboxMessage.create({
      data: {
        organizationId,
        planId: input.planId,
        planStepId: input.planStepId,
        workflowRunId: input.workflowRunId,
        workflowStepRunId: input.workflowStepRunId,
        fromAgentId: input.fromAgentId,
        toAgentId: input.toAgentId,
        channelId: resolvedChannelId,
        threadId: input.threadId,
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
        const matchesExistingRequest =
          existing.body === input.body &&
          existing.channelId === (resolvedChannelId ?? null) &&
          existing.fromAgentId === (input.fromAgentId ?? null) &&
          existing.planId === (input.planId ?? null) &&
          existing.planStepId === (input.planStepId ?? null) &&
          existing.workflowRunId === (input.workflowRunId ?? null) &&
          existing.workflowStepRunId === (input.workflowStepRunId ?? null) &&
          existing.subject === (input.subject ?? null) &&
          existing.threadId === (input.threadId ?? null)

        if (!matchesExistingRequest) {
          throw new Error('MAILBOX_CORRELATION_CONFLICT')
        }

        return mapMailboxMessage(existing)
      }
    }
    throw error
  }

  return mapMailboxMessage(message)
}

export type MailboxClaimResult =
  | { kind: 'claimed'; message: MailboxMessageRecord }
  | { kind: 'not_claimable' }
  | { kind: 'not_found' }

export const claimMailboxMessage = async (
  prisma: PrismaClient,
  organizationId: string,
  messageId: string,
): Promise<MailboxClaimResult> => {
  const existing = await prisma.agentMailboxMessage.findFirst({
    where: {
      id: messageId,
      organizationId,
    },
  })

  if (!existing) {
    return { kind: 'not_found' }
  }

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
    return { kind: 'not_claimable' }
  }

  const message = await prisma.agentMailboxMessage.findUnique({
    where: { id: messageId },
  })
  if (!message) {
    return { kind: 'not_found' }
  }

  return {
    kind: 'claimed',
    message: mapMailboxMessage(message),
  }
}

export type MailboxDeliveryResult =
  | { kind: 'delivered'; message: MailboxMessageRecord }
  | { kind: 'not_deliverable' }
  | { kind: 'not_found' }

export const markMailboxMessageDelivered = async (
  prisma: PrismaClient,
  organizationId: string,
  messageId: string,
): Promise<MailboxDeliveryResult> => {
  const existing = await prisma.agentMailboxMessage.findFirst({
    where: {
      id: messageId,
      organizationId,
    },
  })

  if (!existing) {
    return { kind: 'not_found' }
  }

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
    return { kind: 'not_deliverable' }
  }

  const message = await prisma.agentMailboxMessage.findUnique({
    where: { id: messageId },
  })
  if (!message) {
    return { kind: 'not_found' }
  }

  return {
    kind: 'delivered',
    message: mapMailboxMessage(message),
  }
}
