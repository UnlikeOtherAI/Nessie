import type { Message, PrismaClient, Thread } from '@prisma/client'
import { parseAgentId, parseThreadId, parseUserId } from '@nessie/schemas'
import type { ThreadMessageRecord } from '../contracts.js'

const mapThreadMessageRecord = (message: Message): ThreadMessageRecord => ({
  id: message.id,
  threadId: parseThreadId(message.threadId),
  agentId: message.agentId ? parseAgentId(message.agentId) : undefined,
  userId: message.userId ? parseUserId(message.userId) : undefined,
  role: message.role,
  content: message.content,
  createdAt: message.createdAt.toISOString(),
})

export const findThreadForUser = async (
  prisma: PrismaClient,
  threadId: string,
  userId: string,
): Promise<(Thread & { channel: { id: string } }) | null> =>
  prisma.thread.findFirst({
    where: {
      id: threadId,
      channel: {
        members: {
          some: { userId },
        },
      },
    },
    include: {
      channel: {
        select: { id: true },
      },
    },
  })

export const listThreadMessages = async (
  prisma: PrismaClient,
  threadId: string,
): Promise<ThreadMessageRecord[]> => {
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    select: { id: true },
  })

  if (!thread) {
    return []
  }

  const messages = await prisma.message.findMany({
    where: { threadId },
    orderBy: { createdAt: 'asc' },
  })

  return messages.map(mapThreadMessageRecord)
}

export type CreateThreadMessageResult =
  | {
      kind: 'created'
      message: Message
      run?: {
        agentId: string
        id: string
        status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
        threadId: string
      }
      task?: {
        id: string
      }
    }
  | {
      kind: 'agent_not_bound'
    }
  | {
      kind: 'thread_not_found'
    }

export const createThreadMessage = async (
  prisma: PrismaClient,
  input: {
    agentId?: string
    content: string
    threadId: string
    userId: string
  },
): Promise<CreateThreadMessageResult> => {
  const thread = await prisma.thread.findUnique({
    where: { id: input.threadId },
    include: {
      channel: {
        include: {
          agentBindings: {
            orderBy: { createdAt: 'asc' },
          },
        },
      },
    },
  })

  if (!thread) {
    return {
      kind: 'thread_not_found',
    }
  }

  const selectedBinding = input.agentId
    ? thread.channel.agentBindings.find((binding) => binding.agentId === input.agentId)
    : thread.channel.agentBindings[0]

  if (input.agentId && !selectedBinding) {
    return {
      kind: 'agent_not_bound',
    }
  }

  const created = await prisma.$transaction(async (transaction) => {
    const message = await transaction.message.create({
      data: {
        threadId: input.threadId,
        userId: input.userId,
        role: 'user',
        content: input.content,
      },
    })

    if (!selectedBinding) {
      return {
        message,
      }
    }

    const run = await transaction.run.create({
      data: {
        agentId: selectedBinding.agentId,
        threadId: input.threadId,
        status: 'pending',
      },
      select: {
        agentId: true,
        id: true,
        status: true,
        threadId: true,
      },
    })

    const task = await transaction.task.create({
      data: {
        runId: run.id,
        agentId: selectedBinding.agentId,
        status: 'inbox',
        purpose: input.content.slice(0, 200),
      },
      select: {
        id: true,
      },
    })

    return {
      message,
      run,
      task,
    }
  })

  return {
    kind: 'created',
    message: created.message,
    run: created.run,
    task: created.task,
  }
}
