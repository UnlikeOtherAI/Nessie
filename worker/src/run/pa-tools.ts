import { Prisma, type PrismaClient } from '@prisma/client'
import {
  captureUserMessageMemory,
  resolveAccessibleScopes,
  type ScopeResolutionMode,
} from '@nessie/memory'
import { CHAT_MESSAGE_MAX_CHARS, withActionContext } from '@nessie/schemas'
import {
  parseChannelId,
  parseOrganizationId,
  parseThreadId,
  parseUserId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { enqueueQueueJob } from '../queue.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from './tool-types.js'

type ChannelAgent = {
  id: string
  name: string
  role: string
  systemPrompt: string | null
}

const MAX_SEARCH_RESULTS = 5

const truncate = (value: string, maxLength = 220): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`

const clampLimit = (value: unknown, fallback: number): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), 20)
}

const requireUserActor = (actorContext: AuthorizedActionContext): string => {
  if (actorContext.actor.actorType !== 'user') {
    throw new Error('This tool requires a user actor context.')
  }

  return actorContext.actor.actorId
}

const buildVisibleChannelWhere = (organizationId: string, userId: string) => ({
  organizationId,
  OR: [{ visibility: 'public' as const }, { members: { some: { userId } } }],
})

// The set of channels an agent run may search past conversations in. Shares
// the exact access model used for curated-memory recall, so search can never
// return a conversation outside what the agent (or its acting user) can access.
const resolveAccessibleChannelIds = async (
  context: BuiltinToolRuntimeContext,
): Promise<string[]> => {
  const pool = context.memoryCaptureConfig?.pool
  if (!pool) {
    throw new Error(
      'Conversation search requires a database pool in the runtime context.',
    )
  }

  const effectiveUserId =
    context.actorContext.actionContext.effectiveUserId
    ?? (context.actorContext.actor.actorType === 'user'
      ? context.actorContext.actor.actorId
      : undefined)

  const isPersonalAssistant =
    context.channel.systemChannelType === 'personal_assistant'

  // The personal assistant acts as its owner; without one there is nothing to
  // act as, so it sees nothing.
  if (isPersonalAssistant && !effectiveUserId) {
    return []
  }

  const mode: ScopeResolutionMode = isPersonalAssistant
    ? 'personal_assistant'
    : effectiveUserId
      ? 'user_shared'
      : 'autonomous'

  const scopes = await resolveAccessibleScopes(
    {
      agentId: context.agentId,
      mode,
      organizationId: context.channel.organizationId,
      userId: effectiveUserId ?? null,
    },
    pool,
  )

  return scopes.channelIds
}

const buildSnippet = (content: string, query: string, maxLength = 180): string => {
  const trimmedQuery = query.trim()
  if (!trimmedQuery) {
    return truncate(content, maxLength)
  }

  const lowerContent = content.toLowerCase()
  const lowerQuery = trimmedQuery.toLowerCase()
  const index = lowerContent.indexOf(lowerQuery)
  if (index < 0) {
    return truncate(content, maxLength)
  }

  const halfWindow = Math.floor(maxLength / 2)
  const start = Math.max(0, index - halfWindow)
  const end = Math.min(content.length, index + trimmedQuery.length + halfWindow)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < content.length ? '…' : ''
  return `${prefix}${content.slice(start, end)}${suffix}`
}

const formatSection = (title: string, lines: string[]): string => {
  if (lines.length === 0) {
    return ''
  }

  return [title, ...lines].join('\n')
}

const ensureThreadForChannel = async (
  prisma: PrismaClient,
  channelId: string,
): Promise<string> => {
  const existingThread = await prisma.thread.findFirst({
    where: { channelId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })

  if (existingThread) {
    return existingThread.id
  }

  try {
    const thread = await prisma.thread.create({
      data: {
        channelId,
        title: 'General',
      },
      select: { id: true },
    })
    return thread.id
  } catch {
    const fallback = await prisma.thread.findFirst({
      where: { channelId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (!fallback) {
      throw new Error(`Failed to resolve a thread for channel ${channelId}`)
    }
    return fallback.id
  }
}

const resolveChannelAgents = async (
  prisma: PrismaClient,
  channelId: string,
  organizationId: string,
  content: string,
): Promise<ChannelAgent[]> => {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      agentBindings: {
        orderBy: { createdAt: 'asc' },
        include: {
          agent: {
            select: { id: true, name: true, role: true, systemPrompt: true },
          },
        },
      },
      organizationId: true,
    },
  })

  if (!channel || channel.organizationId !== organizationId) {
    throw new Error('Channel not found')
  }

  const channelAgents: ChannelAgent[] = channel.agentBindings.map((binding) => ({
    id: binding.agent.id,
    name: binding.agent.name,
    role: binding.agent.role,
    systemPrompt: binding.agent.systemPrompt,
  }))

  if (!content.includes('@')) {
    return channelAgents
  }

  const boundIds = new Set(channelAgents.map((agent) => agent.id))
  const candidates = await prisma.agent.findMany({
    where: {
      agentKind: 'shared',
      id: { notIn: [...boundIds] },
      organizationId,
      systemManaged: false,
    },
    select: { id: true, name: true, role: true, systemPrompt: true },
  })

  for (const agent of candidates) {
    const escaped = agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const mentionRe = new RegExp(`@${escaped}(?:\\s|$|[^\\w])`, 'i')
    if (mentionRe.test(content)) {
      channelAgents.push({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        systemPrompt: agent.systemPrompt,
      })
    }
  }

  return channelAgents
}

const resolveDmChannel = async (
  prisma: PrismaClient,
  input: {
    currentUserId: string
    organizationId: string
    teamId: string
    targetUserId: string
  },
): Promise<{ channelId: string; channelLabel: string }> => {
  if (input.currentUserId === input.targetUserId) {
    throw new Error('targetUserId must refer to another user.')
  }

  const memberCount = await prisma.organizationMember.count({
    where: {
      organizationId: input.organizationId,
      userId: { in: [input.currentUserId, input.targetUserId] },
    },
  })
  if (memberCount < 2) {
    throw new Error('Both users must belong to the organization.')
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: input.targetUserId },
    select: { displayName: true },
  })

  const dmKey = [
    input.organizationId,
    input.teamId,
    ...[input.currentUserId, input.targetUserId].sort(),
  ].join(':')

  try {
    const channel = await prisma.channel.upsert({
      where: { dmKey },
      create: {
        label: targetUser?.displayName ?? 'Direct Message',
        type: 'dm',
        organizationId: input.organizationId,
        teamId: input.teamId,
        visibility: 'private',
        dmKey,
        members: {
          create: [{ userId: input.currentUserId }, { userId: input.targetUserId }],
        },
      },
      update: {},
      select: { id: true, label: true },
    })

    return { channelId: channel.id, channelLabel: channel.label }
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'P2002') {
      const channel = await prisma.channel.findUniqueOrThrow({
        where: { dmKey },
        select: { id: true, label: true },
      })
      return { channelId: channel.id, channelLabel: channel.label }
    }

    throw error
  }
}

const resolveMessageDestination = async (
  context: BuiltinToolRuntimeContext,
  input: {
    channelId?: string
    content: string
    targetUserId?: string
    threadId?: string
  },
): Promise<{
  channelId: string
  channelLabel: string
  channelAgents: ChannelAgent[]
  channelType: 'dm' | 'standard'
  systemChannelType: 'personal_assistant' | null
  threadId: string
  threadLabel: string | null
}> => {
  const userId = requireUserActor(context.actorContext)
  const organizationId = context.channel.organizationId
  const explicitDestinationCount = [
    input.threadId ? 1 : 0,
    input.channelId ? 1 : 0,
    input.targetUserId ? 1 : 0,
  ].reduce((sum, value) => sum + value, 0)

  if (explicitDestinationCount > 1) {
    throw new Error('Provide only one of threadId, channelId, or targetUserId.')
  }

  if (input.targetUserId) {
    const teamId = context.actorContext.tenant.teamId
    if (!teamId) {
      throw new Error('Unable to resolve a team context for DM creation.')
    }

    const dm = await resolveDmChannel(context.prisma, {
      currentUserId: userId,
      organizationId,
      targetUserId: input.targetUserId,
      teamId,
    })
    const threadId = await ensureThreadForChannel(context.prisma, dm.channelId)
    const thread = await context.prisma.thread.findUnique({
      where: { id: threadId },
      select: { id: true, title: true },
    })

    return {
      channelAgents: await resolveChannelAgents(
        context.prisma,
        dm.channelId,
        organizationId,
        input.content,
      ),
      channelId: dm.channelId,
      channelLabel: dm.channelLabel,
      channelType: 'dm',
      systemChannelType: null,
      threadId,
      threadLabel: thread?.title ?? null,
    }
  }

  if (input.channelId) {
    const channel = await context.prisma.channel.findFirst({
      where: {
        id: input.channelId,
        ...buildVisibleChannelWhere(organizationId, userId),
      },
      select: {
        id: true,
        label: true,
        type: true,
        systemChannelType: true,
      },
    })

    if (!channel) {
      throw new Error('Channel not found or not visible.')
    }

    const threadId = await ensureThreadForChannel(context.prisma, channel.id)
    const thread = await context.prisma.thread.findUnique({
      where: { id: threadId },
      select: { id: true, title: true },
    })

    return {
      channelAgents: await resolveChannelAgents(
        context.prisma,
        channel.id,
        organizationId,
        input.content,
      ),
      channelId: channel.id,
      channelLabel: channel.label,
      channelType: channel.type,
      systemChannelType: channel.systemChannelType,
      threadId,
      threadLabel: thread?.title ?? null,
    }
  }

  if (input.threadId) {
    const thread = await context.prisma.thread.findFirst({
      where: {
        id: input.threadId,
        channel: buildVisibleChannelWhere(organizationId, userId),
      },
      select: {
        id: true,
        title: true,
        channel: {
          select: {
            id: true,
            label: true,
            type: true,
            systemChannelType: true,
          },
        },
      },
    })

    if (!thread) {
      throw new Error('Thread not found or not visible.')
    }

    return {
      channelAgents: await resolveChannelAgents(
        context.prisma,
        thread.channel.id,
        organizationId,
        input.content,
      ),
      channelId: thread.channel.id,
      channelLabel: thread.channel.label,
      channelType: thread.channel.type,
      systemChannelType: thread.channel.systemChannelType,
      threadId: thread.id,
      threadLabel: thread.title ?? null,
    }
  }

  const fallbackThreadId =
    context.actorContext.actionContext.threadId ?? context.run.threadId
  const thread = await context.prisma.thread.findFirst({
    where: {
      id: fallbackThreadId,
      channel: buildVisibleChannelWhere(organizationId, userId),
    },
    select: {
      id: true,
      title: true,
      channel: {
        select: {
            id: true,
            label: true,
            type: true,
            systemChannelType: true,
          },
        },
    },
  })

  if (!thread) {
    throw new Error('Unable to resolve a destination thread.')
  }

  return {
    channelAgents: await resolveChannelAgents(
      context.prisma,
      thread.channel.id,
      organizationId,
      input.content,
    ),
    channelId: thread.channel.id,
    channelLabel: thread.channel.label,
    channelType: thread.channel.type,
    systemChannelType: thread.channel.systemChannelType,
    threadId: thread.id,
    threadLabel: thread.title ?? null,
  }
}

const buildRealtimeScopesForChannel = (input: {
  channelId: string
  organizationId: string
  systemChannelType: 'personal_assistant' | null
}) =>
  input.systemChannelType === 'personal_assistant'
    ? [{ kind: 'channel' as const, channelId: parseChannelId(input.channelId) }]
    : [
        {
          kind: 'organization' as const,
          organizationId: parseOrganizationId(input.organizationId),
        },
        { kind: 'channel' as const, channelId: parseChannelId(input.channelId) },
      ]

const formatMessageLine = (input: {
  author: string
  channelLabel: string
  createdAt: string
  messageId: string
  snippet: string
  threadLabel: string | null
  threadId: string
}) =>
  [
    `- ${input.author} | ${input.channelLabel}${input.threadLabel ? ` / ${input.threadLabel}` : ''}`,
    `  ${input.createdAt} | messageId=${input.messageId} | threadId=${input.threadId}`,
    `  ${input.snippet}`,
  ].join('\n')

export const runWorkspaceSearchTool = async (
  context: BuiltinToolRuntimeContext,
  query: string,
  limit: unknown = MAX_SEARCH_RESULTS,
): Promise<ToolExecutionResult> => {
  const searchQuery = query.trim()
  if (!searchQuery) {
    throw new Error('query is required.')
  }

  const take = clampLimit(limit, MAX_SEARCH_RESULTS)
  const channelIds = await resolveAccessibleChannelIds(context)
  if (channelIds.length === 0) {
    return {
      inputSummary: `query=${searchQuery}`,
      outputPreview: `No accessible conversations matched "${searchQuery}".`,
      toolName: 'workspace_search',
    }
  }

  const channelFilter = { id: { in: channelIds } }
  const textFilter = { contains: searchQuery, mode: 'insensitive' as const }

  const [channels, threads, messages] = await Promise.all([
    context.prisma.channel.findMany({
      where: {
        ...channelFilter,
        label: textFilter,
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        label: true,
        type: true,
        visibility: true,
        teamId: true,
        threads: {
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { id: true, title: true },
        },
      },
      take,
    }),
    context.prisma.thread.findMany({
      where: {
        channelId: { in: channelIds },
        title: textFilter,
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        channel: {
          select: {
            id: true,
            label: true,
            visibility: true,
          },
        },
      },
      take,
    }),
    context.prisma.message.findMany({
      where: {
        content: textFilter,
        thread: {
          channelId: { in: channelIds },
        },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        content: true,
        createdAt: true,
        thread: {
          select: {
            id: true,
            title: true,
            channel: {
              select: {
                id: true,
                label: true,
              },
            },
          },
        },
        user: {
          select: {
            displayName: true,
            id: true,
          },
        },
        agent: {
          select: {
            name: true,
            id: true,
          },
        },
      },
      take,
    }),
  ])

  const lines: string[] = []

  const channelLines = channels.map((channel, index) => {
    const thread = channel.threads[0]
    return [
      `${index + 1}. #${channel.label} | channelId=${channel.id} | visibility=${channel.visibility} | type=${channel.type}`,
      thread ? `   threadId=${thread.id}${thread.title ? ` | thread="${thread.title}"` : ''}` : '   threadId=none',
    ].join('\n')
  })
  const threadLines = threads.map((thread, index) =>
    [
      `${index + 1}. #${thread.channel.label} / ${thread.title ?? '(untitled)'} | threadId=${thread.id}`,
      `   channelId=${thread.channel.id} | visibility=${thread.channel.visibility}`,
    ].join('\n'),
  )
  const messageLines = messages.map((message, index) =>
    formatMessageLine({
      author:
        message.user?.displayName ??
        message.agent?.name ??
        'Unknown',
      channelLabel: `#${message.thread.channel.label}`,
      createdAt: message.createdAt.toISOString(),
      messageId: message.id,
      snippet: buildSnippet(message.content, searchQuery),
      threadLabel: message.thread.title ?? null,
      threadId: message.thread.id,
    }).replace(/^-\s/, `${index + 1}. `),
  )

  lines.push(
    formatSection(`Channels (${channelLines.length})`, channelLines),
    formatSection(`Threads (${threadLines.length})`, threadLines),
    formatSection(`Messages (${messageLines.length})`, messageLines),
  )

  const outputPreview =
    lines.filter((line) => line.length > 0).join('\n\n') ||
    `No visible channels, threads, or messages matched "${searchQuery}".`

  return {
    inputSummary: `query=${searchQuery}`,
    outputPreview: truncate(outputPreview, 4000),
    toolName: 'workspace_search',
  }
}

export const runAuthoredMessageSearchTool = async (
  context: BuiltinToolRuntimeContext,
  query: string,
  limit: unknown = MAX_SEARCH_RESULTS,
): Promise<ToolExecutionResult> => {
  const searchQuery = query.trim()
  if (!searchQuery) {
    throw new Error('query is required.')
  }

  // This tool is inherently about "messages authored by the current user", so
  // it only applies when a user is in the loop. Autonomous runs get nothing.
  const userId =
    context.actorContext.actor.actorType === 'user'
      ? context.actorContext.actor.actorId
      : context.actorContext.actionContext.effectiveUserId
  if (!userId) {
    return {
      inputSummary: `query=${searchQuery}`,
      outputPreview:
        'authored_message_search is only available when acting on behalf of a user.',
      toolName: 'authored_message_search',
    }
  }

  const take = clampLimit(limit, MAX_SEARCH_RESULTS)
  const visibleChannelWhere = buildVisibleChannelWhere(context.channel.organizationId, userId)
  const textFilter = { contains: searchQuery, mode: 'insensitive' as const }

  const messages = await context.prisma.message.findMany({
    where: {
      userId,
      content: textFilter,
      thread: {
        channel: visibleChannelWhere,
      },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      content: true,
      createdAt: true,
      thread: {
        select: {
          id: true,
          title: true,
          channel: {
            select: {
              id: true,
              label: true,
            },
          },
        },
      },
    },
    take,
  })

  const messageLines = messages.map((message, index) =>
    [
      `${index + 1}. #${message.thread.channel.label} / ${message.thread.title ?? '(untitled)'}`,
      `   ${message.createdAt.toISOString()} | messageId=${message.id} | threadId=${message.thread.id}`,
      `   ${buildSnippet(message.content, searchQuery)}`,
    ].join('\n'),
  )

  return {
    inputSummary: `query=${searchQuery}`,
    outputPreview:
      formatSection(`Authored messages (${messageLines.length})`, messageLines) ||
      `No authored messages matched "${searchQuery}".`,
    toolName: 'authored_message_search',
  }
}

export const runPeopleSearchTool = async (
  context: BuiltinToolRuntimeContext,
  query: string,
  limit: unknown = 10,
): Promise<ToolExecutionResult> => {
  const searchQuery = query.trim()
  if (!searchQuery) {
    throw new Error('query is required.')
  }

  const take = clampLimit(limit, 10)
  const people = await context.prisma.user.findMany({
    where: {
      organizationMembers: {
        some: { organizationId: context.channel.organizationId },
      },
      OR: [
        { displayName: { contains: searchQuery, mode: 'insensitive' } },
        { email: { contains: searchQuery, mode: 'insensitive' } },
      ],
    },
    orderBy: { displayName: 'asc' },
    select: {
      id: true,
      displayName: true,
      email: true,
      organizationMembers: {
        where: { organizationId: context.channel.organizationId },
        select: { role: true },
        take: 1,
      },
    },
    take,
  })

  const lines = people.map((person, index) => {
    const role = person.organizationMembers[0]?.role ?? 'member'
    const youLabel = person.id === requireUserActor(context.actorContext) ? ' (you)' : ''
    return `${index + 1}. ${person.displayName}${youLabel} <${person.email}> | userId=${person.id} | role=${role}`
  })

  return {
    inputSummary: `query=${searchQuery}`,
    outputPreview:
      formatSection(`People (${lines.length})`, lines) ||
      `No people matched "${searchQuery}".`,
    toolName: 'people_search',
  }
}

export const runUpdatePreferencesTool = async (
  context: BuiltinToolRuntimeContext,
  preferences: Record<string, unknown> | null,
): Promise<ToolExecutionResult> => {
  if (!preferences || Object.keys(preferences).length === 0) {
    throw new Error('preferences must be a non-empty object.')
  }

  const userId = requireUserActor(context.actorContext)
  const updatedUser = await context.prisma.user.update({
    where: { id: parseUserId(userId) },
    data: { preferences: preferences as Prisma.InputJsonValue },
    select: {
      id: true,
      preferences: true,
    },
  })

  return {
    inputSummary: 'preferences',
    outputPreview: `Updated preferences for userId=${updatedUser.id}\n${JSON.stringify(
      updatedUser.preferences ?? {},
    )}`,
    toolName: 'update_preferences',
  }
}

export const runSendMessageTool = async (
  context: BuiltinToolRuntimeContext,
  input: {
    channelId?: string
    content: string
    targetUserId?: string
    threadId?: string
  },
): Promise<ToolExecutionResult> => {
  const userId = requireUserActor(context.actorContext)
  const content = input.content.trim()
  if (!content) {
    throw new Error('content is required.')
  }
  if (content.length > CHAT_MESSAGE_MAX_CHARS) {
    throw new Error(
      `Message is ${content.length} characters; the limit is ${CHAT_MESSAGE_MAX_CHARS}.`,
    )
  }

  const destination = await resolveMessageDestination(context, input)
  if (destination.systemChannelType === 'personal_assistant') {
    throw new Error(
      'send_message cannot target the Personal Assistant DM. Reply in the current chat instead.',
    )
  }

  const message = await context.prisma.message.create({
    data: {
      content,
      metadata: {
        delegatedByAgentId: context.agentId,
        delegatedFromRunId: context.run.id,
      } as Prisma.InputJsonValue,
      role: 'user',
      threadId: parseThreadId(destination.threadId),
      userId: parseUserId(userId),
    },
    select: {
      id: true,
      createdAt: true,
      threadId: true,
    },
  })

  if (context.memoryCaptureConfig) {
    await captureUserMessageMemory(
      {
        channelId: destination.channelId,
        content,
        memoryOrigin: 'user_authored_workspace_message',
        messageId: message.id,
        organizationId: context.channel.organizationId,
        sourceAudience: destination.channelType === 'dm' ? 'dm' : 'channel',
        threadId: destination.threadId,
        userId,
      },
      context.memoryCaptureConfig,
    )
  }

  await context.realtimeTransport.publishWs(
    buildRealtimeScopesForChannel({
      channelId: destination.channelId,
      organizationId: context.channel.organizationId,
      systemChannelType: destination.systemChannelType,
    }),
    {
      data: {
        agentId: undefined,
        contentPreview: content.slice(0, 200),
        messageId: message.id,
        role: 'user',
        threadId: parseThreadId(destination.threadId),
      },
      event: 'message.new',
    },
  )

  let queuedReplyCount = 0
  if (destination.channelAgents.length > 0) {
    const enqueued = await enqueueQueueJob(
      context.prisma,
      {
        idempotencyKey: `orchestrate:${message.id}`,
        payload: {
          actorContext: withActionContext(context.actorContext, {
            channelId: parseChannelId(destination.channelId),
            effectiveUserId: parseUserId(userId),
            threadId: parseThreadId(destination.threadId),
          }),
          channelAgents: destination.channelAgents,
          channelId: parseChannelId(destination.channelId),
          content,
          messageId: message.id,
          role: 'user',
          threadId: parseThreadId(destination.threadId),
        },
        topic: 'orchestrate.decide',
      },
    )
    queuedReplyCount = enqueued ? destination.channelAgents.length : 0
  }

  const destinationSummary =
    input.targetUserId
      ? `DM sent to userId=${input.targetUserId}`
      : input.threadId
        ? `Message sent to threadId=${destination.threadId}`
        : input.channelId
          ? `Message sent to channelId=${destination.channelId}`
          : `Message sent to current threadId=${destination.threadId}`

  return {
    inputSummary: truncate(content, 200),
    outputPreview: [
      destinationSummary,
      `channelId=${destination.channelId} | channel="${destination.channelLabel}"`,
      `threadId=${destination.threadId}${destination.threadLabel ? ` | thread="${destination.threadLabel}"` : ''}`,
      `messageId=${message.id}`,
      `agentsNotified=${queuedReplyCount}`,
    ].join('\n'),
    toolName: 'send_message',
  }
}
