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
): Promise<(Thread & { channel: { id: string; organizationId: string } }) | null> =>
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
        select: {
          id: true,
          organizationId: true,
        },
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

/** Extract @Name mentions from message content. */
const extractMentions = (content: string): string[] => {
  const results: string[] = []
  const pattern = /@([\w][\w\s]*[\w]|[\w]+)/g
  let m: RegExpExecArray | null = null
  do {
    m = pattern.exec(content)
    if (m?.[1]) results.push(m[1])
  } while (m)
  return results
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
            include: { agent: { select: { name: true } } },
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

  // Determine whether an agent should respond based on @mentions
  const mentions = extractMentions(input.content)
  let selectedBinding: (typeof thread.channel.agentBindings)[number] | undefined =
    input.agentId
      ? thread.channel.agentBindings.find((b) => b.agentId === input.agentId)
      : thread.channel.agentBindings[0]

  if (mentions.length > 0) {
    // Check if any mention targets a bound agent
    const mentionedAgentBinding = thread.channel.agentBindings.find((b) =>
      mentions.some((name) => b.agent.name.toLowerCase() === name.toLowerCase()),
    )
    if (mentionedAgentBinding) {
      // Route to the mentioned agent
      selectedBinding = mentionedAgentBinding
    } else {
      // Mentions exist but none match an agent — don't dispatch
      selectedBinding = undefined
    }
  }

  if (input.agentId && !thread.channel.agentBindings.some((b) => b.agentId === input.agentId)) {
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
