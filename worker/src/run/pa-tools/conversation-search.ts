import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import {
  buildVisibleChannelWhere,
  isDelegatingPersonalAssistant,
  resolveAccessibleChannelIds,
} from './access.js'
import {
  buildSnippet,
  clampLimit,
  formatMessageLine,
  formatSection,
  MAX_SEARCH_RESULTS,
  truncate,
} from './tool-output.js'

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
      thread
        ? `   threadId=${thread.id}${thread.title ? ` | thread="${thread.title}"` : ''}`
        : '   threadId=none',
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
  const visibleChannelWhere = buildVisibleChannelWhere(
    context.channel.organizationId,
    userId,
    isDelegatingPersonalAssistant(context),
  )
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
