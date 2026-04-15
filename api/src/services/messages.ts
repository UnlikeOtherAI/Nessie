import type { Message, PrismaClient, Thread } from '@prisma/client'
import { parseAgentId, parseThreadId, parseUserId } from '@nessie/schemas'
import type { ThreadMessageRecord } from '../contracts.js'

type MessageWithReactions = Message & {
  reactions: Array<{
    id: string
    messageId: string
    agentId: string | null
    userId: string | null
    emoji: string
    createdAt: Date
  }>
}

const mapThreadMessageRecord = (message: MessageWithReactions): ThreadMessageRecord => ({
  id: message.id,
  threadId: parseThreadId(message.threadId),
  agentId: message.agentId ? parseAgentId(message.agentId) : undefined,
  userId: message.userId ? parseUserId(message.userId) : undefined,
  role: message.role,
  content: message.content,
  createdAt: message.createdAt.toISOString(),
  metadata:
    message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : undefined,
  reactions: message.reactions.map((r) => ({
    id: r.id,
    messageId: r.messageId,
    agentId: r.agentId ? parseAgentId(r.agentId) : undefined,
    userId: r.userId ? parseUserId(r.userId) : undefined,
    emoji: r.emoji,
    createdAt: r.createdAt.toISOString(),
  })),
})

export const findThreadForUser = async (
  prisma: PrismaClient,
  threadId: string,
  userId: string,
): Promise<
  (Thread & {
    channel: {
      id: string
      organizationId: string
      type: 'dm' | 'standard'
      systemChannelType: 'personal_assistant' | null
    }
  }) | null
> =>
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
          type: true,
          systemChannelType: true,
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
    include: { reactions: true },
  })

  return messages.map(mapThreadMessageRecord)
}

export const markThreadRead = async (
  prisma: PrismaClient,
  input: {
    threadId: string
    userId: string
  },
): Promise<void> => {
  const latestMessage = await prisma.message.findFirst({
    where: { threadId: input.threadId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })

  await prisma.threadReadState.upsert({
    where: {
      threadId_userId: {
        threadId: input.threadId,
        userId: input.userId,
      },
    },
    create: {
      threadId: input.threadId,
      userId: input.userId,
      lastReadAt: latestMessage?.createdAt ?? new Date(),
    },
    update: {
      lastReadAt: latestMessage?.createdAt ?? new Date(),
    },
  })
}

export type ChannelAgent = {
  id: string
  name: string
  role: string
  systemPrompt: string | null
}

export type CreateThreadMessageResult =
  | {
      kind: 'created'
      message: Message
      channelAgents: ChannelAgent[]
    }
  | {
      kind: 'thread_not_found'
    }

export const createThreadMessage = async (
  prisma: PrismaClient,
  input: {
    content: string
    threadId: string
    userId: string
  },
): Promise<CreateThreadMessageResult> => {
  const thread = await prisma.thread.findUnique({
    where: { id: input.threadId },
    select: {
      channel: {
        select: {
          agentBindings: {
            include: {
              agent: {
                select: { id: true, name: true, role: true, systemPrompt: true },
              },
            },
            orderBy: { createdAt: 'asc' },
          },
          organizationId: true,
          systemChannelType: true,
        },
      },
    },
  })

  if (!thread) {
    return { kind: 'thread_not_found' }
  }

  const message = await prisma.message.create({
    data: {
      threadId: input.threadId,
      userId: input.userId,
      role: 'user',
      content: input.content,
    },
  })

  const channelAgents: ChannelAgent[] = thread.channel.agentBindings.map((b) => ({
    id: b.agent.id,
    name: b.agent.name,
    role: b.agent.role,
    systemPrompt: b.agent.systemPrompt,
  }))
  const resolvedChannelAgents =
    thread.channel.systemChannelType === 'personal_assistant'
      ? channelAgents.slice(0, 1)
      : channelAgents

  // Also resolve @mentioned agents not yet bound to this channel. Agent
  // names can contain spaces, so we can't split them out of free text with
  // a regex alone — we fetch the candidate list first and then match each
  // name against the content with the same escape rule the orchestrator
  // uses, so parsing is identical on both sides.
  if (input.content.includes('@')) {
    const boundIds = new Set(resolvedChannelAgents.map((a) => a.id))
    const candidates = await prisma.agent.findMany({
      where: {
        agentKind: 'shared',
        id: { notIn: [...boundIds] },
        organizationId: thread.channel.organizationId,
        systemManaged: false,
      },
      select: { id: true, name: true, role: true, systemPrompt: true },
    })

    for (const agent of candidates) {
      const escaped = agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const mentionRe = new RegExp(`@${escaped}(?:\\s|$|[^\\w])`, 'i')
      if (mentionRe.test(input.content)) {
        resolvedChannelAgents.push({
          id: agent.id,
          name: agent.name,
          role: agent.role,
          systemPrompt: agent.systemPrompt,
        })
      }
    }
  }

  return {
    kind: 'created',
    message,
    channelAgents: resolvedChannelAgents,
  }
}

export const addReaction = async (
  prisma: PrismaClient,
  input: {
    messageId: string
    agentId?: string
    userId?: string
    emoji: string
  },
) => {
  return prisma.messageReaction.upsert({
    where: input.agentId
      ? { messageId_agentId_emoji: { messageId: input.messageId, agentId: input.agentId, emoji: input.emoji } }
      : { messageId_userId_emoji: { messageId: input.messageId, userId: input.userId!, emoji: input.emoji } },
    update: {},
    create: {
      messageId: input.messageId,
      agentId: input.agentId ?? null,
      userId: input.userId ?? null,
      emoji: input.emoji,
    },
  })
}
