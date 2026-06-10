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
import { randomUUID } from 'node:crypto'
import { loadConfig } from '@nessie/config'
import { getStorage, type StorageConfig } from '@nessie/runtime'
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
        channelId: parseChannelId(destination.channelId),
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

// ─── sp-messaging slice: agent message search + lifecycle ──────────────────

type MessageSearchRow = {
  id: string
  thread_id: string
  channel_id: string
  channel_label: string
  content: string
  created_at: Date
  author_name: string | null
}

export const runMessageSearchTool = async (
  context: BuiltinToolRuntimeContext,
  input: { query: string; channelId?: string; limit?: unknown },
): Promise<ToolExecutionResult> => {
  const searchQuery = input.query.trim()
  if (!searchQuery) {
    throw new Error('query is required.')
  }

  const take = clampLimit(input.limit, MAX_SEARCH_RESULTS)
  let channelIds = await resolveAccessibleChannelIds(context)
  if (input.channelId) {
    channelIds = channelIds.filter((id) => id === input.channelId)
  }
  if (channelIds.length === 0) {
    return {
      inputSummary: `query=${searchQuery}`,
      outputPreview: `No accessible channels matched "${searchQuery}".`,
      toolName: 'message_search',
    }
  }

  // Full-text search mirroring the api searchMessages service: english
  // tsvector match, soft-deleted rows excluded, scoped to visible channels.
  const rows = await context.prisma.$queryRaw<MessageSearchRow[]>(Prisma.sql`
    SELECT
      m."id",
      m."thread_id",
      c."id" AS channel_id,
      c."label" AS channel_label,
      m."content",
      m."created_at",
      COALESCE(u."display_name", a."name") AS author_name
    FROM "messages" m
    JOIN "threads" t ON t."id" = m."thread_id"
    JOIN "channels" c ON c."id" = t."channel_id"
    LEFT JOIN "users" u ON u."id" = m."user_id"
    LEFT JOIN "agents" a ON a."id" = m."agent_id"
    WHERE m."deleted_at" IS NULL
      AND t."channel_id" IN (${Prisma.join(channelIds)})
      AND to_tsvector('english', m."content") @@ plainto_tsquery('english', ${searchQuery})
    ORDER BY m."created_at" DESC
    LIMIT ${take}
  `)

  const lines = rows.map((row, index) =>
    [
      `${index + 1}. ${row.author_name ?? 'Unknown'} | #${row.channel_label}`,
      `   ${row.created_at.toISOString()} | messageId=${row.id} | threadId=${row.thread_id}`,
      `   ${buildSnippet(row.content, searchQuery)}`,
    ].join('\n'),
  )

  return {
    inputSummary: `query=${searchQuery}`,
    outputPreview:
      formatSection(`Messages (${lines.length})`, lines) ||
      `No messages matched "${searchQuery}".`,
    toolName: 'message_search',
  }
}

export const runMessageEditTool = async (
  context: BuiltinToolRuntimeContext,
  input: { messageId: string; content: string },
): Promise<ToolExecutionResult> => {
  const content = input.content.trim()
  if (!input.messageId) {
    throw new Error('messageId is required.')
  }
  if (!content) {
    throw new Error('content is required.')
  }
  if (content.length > CHAT_MESSAGE_MAX_CHARS) {
    throw new Error(
      `Message is ${content.length} characters; the limit is ${CHAT_MESSAGE_MAX_CHARS}.`,
    )
  }

  // Agents may only edit messages they authored themselves.
  const existing = await context.prisma.message.findFirst({
    where: { id: input.messageId, agentId: context.agentId, deletedAt: null },
    select: { id: true },
  })
  if (!existing) {
    throw new Error('Message not found or not authored by this agent.')
  }

  await context.prisma.message.update({
    where: { id: input.messageId },
    data: { content, editedAt: new Date() },
  })

  return {
    inputSummary: `messageId=${input.messageId}`,
    outputPreview: `Edited messageId=${input.messageId}`,
    toolName: 'message_edit',
  }
}

export const runMessageDeleteTool = async (
  context: BuiltinToolRuntimeContext,
  input: { messageId: string },
): Promise<ToolExecutionResult> => {
  if (!input.messageId) {
    throw new Error('messageId is required.')
  }

  const existing = await context.prisma.message.findFirst({
    where: { id: input.messageId, agentId: context.agentId, deletedAt: null },
    select: { id: true },
  })
  if (!existing) {
    throw new Error('Message not found or not authored by this agent.')
  }

  await context.prisma.message.update({
    where: { id: input.messageId },
    data: { deletedAt: new Date(), content: '' },
  })

  return {
    inputSummary: `messageId=${input.messageId}`,
    outputPreview: `Deleted messageId=${input.messageId}`,
    toolName: 'message_delete',
  }
}

// ─── File uploads / attachments (Slack-parity files slice) ──────────────────

const ATTACHMENT_READ_MAX_TEXT_BYTES = 64 * 1024

const attachmentKindFromMime = (mime: string): string => {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('text/')) return 'text'
  return 'file'
}

const isTextLikeMime = (mime: string): boolean =>
  mime.startsWith('text/') ||
  mime === 'application/json' ||
  mime === 'application/xml' ||
  mime.endsWith('+json') ||
  mime.endsWith('+xml')

const attachmentStorageConfig = (): StorageConfig => {
  const config = loadConfig()
  return {
    provider: config.storage.provider,
    bucket: config.storage.bucket,
    localPath: config.storage.localPath,
  }
}

export const runAttachmentUploadTool = async (
  context: BuiltinToolRuntimeContext,
  input: { filename?: string; mime?: string; contentBase64?: string },
): Promise<ToolExecutionResult> => {
  const filename = (input.filename ?? '').trim()
  const mime = (input.mime ?? '').trim() || 'application/octet-stream'
  if (!filename) {
    throw new Error('filename is required.')
  }
  if (!input.contentBase64) {
    throw new Error('contentBase64 is required.')
  }

  const bytes = Buffer.from(input.contentBase64, 'base64')
  if (bytes.byteLength === 0) {
    throw new Error('contentBase64 decoded to zero bytes.')
  }

  const organizationId = context.channel.organizationId
  const uploaderId =
    context.actorContext.actor.actorType === 'user'
      ? context.actorContext.actor.actorId
      : context.actorContext.actionContext.effectiveUserId ?? null

  const storageKey = `${organizationId}/${randomUUID()}`
  const storage = getStorage(attachmentStorageConfig())
  await storage.put(storageKey, bytes, mime)

  const attachment = await context.prisma.attachment.create({
    data: {
      organizationId,
      uploaderId,
      kind: attachmentKindFromMime(mime),
      mime,
      filename,
      sizeBytes: bytes.byteLength,
      storageKey,
    },
    select: { id: true, filename: true, mime: true, sizeBytes: true },
  })

  return {
    inputSummary: `filename=${filename}`,
    outputPreview: [
      `Uploaded attachment id=${attachment.id}`,
      `filename=${attachment.filename} | mime=${attachment.mime} | sizeBytes=${attachment.sizeBytes}`,
      'Link it to a message via send_message attachmentIds.',
    ].join('\n'),
    toolName: 'attachment_upload',
  }
}

export const runAttachmentListTool = async (
  context: BuiltinToolRuntimeContext,
  input: { threadId?: string; channelId?: string; limit?: unknown },
): Promise<ToolExecutionResult> => {
  const userId =
    context.actorContext.actor.actorType === 'user'
      ? context.actorContext.actor.actorId
      : context.actorContext.actionContext.effectiveUserId ?? null

  const organizationId = context.channel.organizationId
  const take = clampLimit(input.limit, 20)

  // Resolve the candidate message ids in a thread/channel the caller can see,
  // then list attachments linked to those messages. Without a user context fall
  // back to the run's own thread.
  const threadId = input.threadId ?? (input.channelId ? undefined : context.run.threadId)
  const visibleChannel = userId
    ? buildVisibleChannelWhere(organizationId, userId)
    : { organizationId }

  const messageWhere = input.channelId
    ? { thread: { channelId: input.channelId, channel: visibleChannel } }
    : { thread: { id: threadId, channel: visibleChannel } }

  const messages = await context.prisma.message.findMany({
    where: messageWhere,
    select: { id: true },
    take: 200,
  })
  const messageIds = messages.map((m) => m.id)

  if (messageIds.length === 0) {
    return {
      inputSummary: input.channelId ? `channelId=${input.channelId}` : `threadId=${threadId}`,
      outputPreview: 'No accessible messages found for the requested scope.',
      toolName: 'attachment_list',
    }
  }

  const attachments = await context.prisma.attachment.findMany({
    where: { organizationId, messageId: { in: messageIds } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, filename: true, mime: true, sizeBytes: true },
    take,
  })

  const lines = attachments.map(
    (a, index) =>
      `${index + 1}. id=${a.id} | ${a.filename} | mime=${a.mime} | sizeBytes=${a.sizeBytes}`,
  )

  return {
    inputSummary: input.channelId ? `channelId=${input.channelId}` : `threadId=${threadId}`,
    outputPreview:
      formatSection(`Attachments (${lines.length})`, lines) || 'No attachments found.',
    toolName: 'attachment_list',
  }
}

export const runAttachmentReadTool = async (
  context: BuiltinToolRuntimeContext,
  input: { id?: string },
): Promise<ToolExecutionResult> => {
  const id = (input.id ?? '').trim()
  if (!id) {
    throw new Error('id is required.')
  }

  const attachment = await context.prisma.attachment.findUnique({ where: { id } })
  if (!attachment || attachment.organizationId !== context.channel.organizationId) {
    throw new Error('Attachment not found.')
  }

  const metadataLines = [
    `id=${attachment.id}`,
    `filename=${attachment.filename}`,
    `mime=${attachment.mime}`,
    `kind=${attachment.kind}`,
    `sizeBytes=${attachment.sizeBytes}`,
  ]

  if (!isTextLikeMime(attachment.mime) || attachment.sizeBytes > ATTACHMENT_READ_MAX_TEXT_BYTES) {
    return {
      inputSummary: `id=${id}`,
      outputPreview: [
        ...metadataLines,
        'content=(binary or too large to inline; metadata only)',
      ].join('\n'),
      toolName: 'attachment_read',
    }
  }

  const storage = getStorage(attachmentStorageConfig())
  const bytes = await storage.get(attachment.storageKey)
  if (!bytes) {
    return {
      inputSummary: `id=${id}`,
      outputPreview: [...metadataLines, 'content=(stored bytes missing)'].join('\n'),
      toolName: 'attachment_read',
    }
  }

  return {
    inputSummary: `id=${id}`,
    outputPreview: [...metadataLines, 'content:', truncate(bytes.toString('utf8'), 8000)].join(
      '\n',
    ),
    toolName: 'attachment_read',
  }
}

// ─── sp-channels: channel lifecycle tools ────────────────────────────────────

// Mirror of api/src/services/channels.ts toChannelSlug — the worker cannot
// import from api/, so the rule is re-implemented here to keep validation
// consistent across the REST surface and the agent tools.
const toChannelSlug = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

// Channel-manage authz mirrored from api/src/services/channels.ts canManageChannel:
// channel owner/admin, org owner/admin, or team owner/admin may manage.
const canManageChannel = async (
  prisma: PrismaClient,
  input: { userId: string; organizationId: string; channelId: string },
): Promise<boolean> => {
  const channel = await prisma.channel.findUnique({
    where: { id: input.channelId },
    select: { organizationId: true, teamId: true },
  })
  if (!channel || channel.organizationId !== input.organizationId) {
    return false
  }

  const [channelMember, orgMember, teamMember] = await Promise.all([
    prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId: input.channelId, userId: input.userId } },
      select: { role: true },
    }),
    prisma.organizationMember.findFirst({
      where: { organizationId: input.organizationId, userId: input.userId },
      select: { role: true },
    }),
    prisma.teamMember.findFirst({
      where: { teamId: channel.teamId, userId: input.userId },
      select: { role: true },
    }),
  ])

  return (
    channelMember?.role === 'owner'
    || channelMember?.role === 'admin'
    || orgMember?.role === 'owner'
    || orgMember?.role === 'admin'
    || teamMember?.role === 'owner'
    || teamMember?.role === 'admin'
  )
}

export const runChannelListTool = async (
  context: BuiltinToolRuntimeContext,
  input: { includeArchived?: boolean; limit?: unknown },
): Promise<ToolExecutionResult> => {
  const userId = requireUserActor(context.actorContext)
  const organizationId = context.channel.organizationId
  const take = clampLimit(input.limit, 20)

  const channels = await context.prisma.channel.findMany({
    where: {
      ...buildVisibleChannelWhere(organizationId, userId),
      ...(input.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      label: true,
      visibility: true,
      topic: true,
      archivedAt: true,
    },
    take,
  })

  const lines = channels.map((channel, index) =>
    `${index + 1}. #${channel.label} | channelId=${channel.id} | visibility=${channel.visibility}`
    + ` | archived=${channel.archivedAt ? 'yes' : 'no'}`
    + (channel.topic ? ` | topic="${channel.topic}"` : ''),
  )

  return {
    inputSummary: `includeArchived=${Boolean(input.includeArchived)}`,
    outputPreview:
      formatSection(`Channels (${lines.length})`, lines) || 'No channels visible.',
    toolName: 'channel_list',
  }
}

export const runChannelUpdateTool = async (
  context: BuiltinToolRuntimeContext,
  input: {
    channelId: string
    label?: string
    topic?: string
    description?: string
  },
): Promise<ToolExecutionResult> => {
  const userId = requireUserActor(context.actorContext)
  const organizationId = context.channel.organizationId
  if (!input.channelId) {
    throw new Error('channelId is required.')
  }
  if (
    input.label === undefined
    && input.topic === undefined
    && input.description === undefined
  ) {
    throw new Error('Provide at least one of label, topic, or description.')
  }

  const canManage = await canManageChannel(context.prisma, {
    channelId: input.channelId,
    organizationId,
    userId,
  })
  if (!canManage) {
    throw new Error('Channel not found or insufficient permissions to manage it.')
  }

  const data: Prisma.ChannelUpdateInput = {}
  if (input.label !== undefined) {
    const label = input.label.trim()
    if (toChannelSlug(label).length === 0) {
      throw new Error('Channel name must contain at least one letter or number.')
    }
    data.label = label
  }
  if (input.topic !== undefined) {
    data.topic = input.topic
  }
  if (input.description !== undefined) {
    data.description = input.description
  }

  const channel = await context.prisma.channel.update({
    where: { id: input.channelId },
    data,
    select: { id: true, label: true, topic: true, description: true },
  })

  return {
    inputSummary: `channelId=${input.channelId}`,
    outputPreview: [
      `Updated channelId=${channel.id}`,
      `label="${channel.label}"`,
      `topic=${channel.topic ? `"${channel.topic}"` : '(none)'}`,
      `description=${channel.description ? `"${truncate(channel.description, 120)}"` : '(none)'}`,
    ].join('\n'),
    toolName: 'channel_update',
  }
}

export const runChannelArchiveTool = async (
  context: BuiltinToolRuntimeContext,
  input: { channelId: string; archived?: boolean },
): Promise<ToolExecutionResult> => {
  const userId = requireUserActor(context.actorContext)
  const organizationId = context.channel.organizationId
  if (!input.channelId) {
    throw new Error('channelId is required.')
  }

  const archived = input.archived ?? true
  const canManage = await canManageChannel(context.prisma, {
    channelId: input.channelId,
    organizationId,
    userId,
  })
  if (!canManage) {
    throw new Error('Channel not found or insufficient permissions to manage it.')
  }

  const channel = await context.prisma.channel.update({
    where: { id: input.channelId },
    data: { archivedAt: archived ? new Date() : null },
    select: { id: true, label: true, archivedAt: true },
  })

  return {
    inputSummary: `channelId=${input.channelId} archived=${archived}`,
    outputPreview:
      `${channel.archivedAt ? 'Archived' : 'Unarchived'} channelId=${channel.id} | #${channel.label}`,
    toolName: 'channel_archive',
  }
}

export const runChannelJoinTool = async (
  context: BuiltinToolRuntimeContext,
  input: { channelId: string },
): Promise<ToolExecutionResult> => {
  const userId = requireUserActor(context.actorContext)
  const organizationId = context.channel.organizationId
  if (!input.channelId) {
    throw new Error('channelId is required.')
  }

  const channel = await context.prisma.channel.findUnique({
    where: { id: input.channelId },
    select: { organizationId: true, label: true, visibility: true, archivedAt: true },
  })
  if (!channel || channel.organizationId !== organizationId) {
    throw new Error('Channel not found.')
  }
  if (channel.visibility !== 'public' || channel.archivedAt) {
    throw new Error('Only active public channels can be joined.')
  }

  const isOrgMember = await context.prisma.organizationMember.count({
    where: { organizationId, userId },
  })
  if (!isOrgMember) {
    throw new Error('You are not a member of this organization.')
  }

  await context.prisma.channelMember.upsert({
    where: { channelId_userId: { channelId: input.channelId, userId } },
    create: { channelId: input.channelId, userId },
    update: {},
  })

  return {
    inputSummary: `channelId=${input.channelId}`,
    outputPreview: `Joined channelId=${input.channelId} | #${channel.label}`,
    toolName: 'channel_join',
  }
}
