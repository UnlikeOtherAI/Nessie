import { Prisma } from '@prisma/client'
import { buildPrefixTsQuery } from '@nessie/runtime'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import {
  buildVisibleChannelWhere,
  resolveAccessibleChannelIds,
} from './access.js'
import {
  buildSnippet,
  clampLimit,
  formatChannelRef,
  formatMessageLine,
  formatSection,
  MAX_SEARCH_RESULTS,
  truncate,
} from './tool-output.js'

type MessageIdRow = { id: string }

/**
 * Candidate message ids for an agent content search, matched through the
 * message full-text index rather than a `contains` (ILIKE) predicate, which
 * Postgres cannot serve from an index and which therefore scanned every message
 * the agent could reach. Access scoping is unchanged: the caller supplies either
 * an explicit accessible-channel id list or the visible-channel predicate, and
 * both are applied inside this query.
 */
const searchMessageIdsByContent = async (
  context: BuiltinToolRuntimeContext,
  input: {
    authorUserId?: string
    channelIds?: string[]
    query: string
    take: number
    visibleChannelWhere?: Prisma.ChannelWhereInput
  },
): Promise<string[]> => {
  const prefixQuery = buildPrefixTsQuery(input.query)
  if (!prefixQuery) return []

  // The visible-channel form is a Prisma predicate, so resolve it to ids first
  // and keep one SQL shape for both callers.
  const channelIds = input.channelIds
    ?? (input.visibleChannelWhere
      ? (
        await context.prisma.channel.findMany({
          where: input.visibleChannelWhere,
          select: { id: true },
        })
      ).map((channel) => channel.id)
      : [])
  if (channelIds.length === 0) return []

  const rows = await context.prisma.$queryRaw<MessageIdRow[]>(Prisma.sql`
    SELECT m."id"
      FROM "messages" m
      JOIN "threads" t ON t."id" = m."thread_id"
     WHERE t."channel_id" IN (${Prisma.join(
       channelIds.map((id) => Prisma.sql`${id}::uuid`),
     )})
       AND m."deleted_at" IS NULL
       AND to_tsvector('english', m."content") @@ to_tsquery('english', ${prefixQuery})
       ${input.authorUserId
         ? Prisma.sql`AND m."user_id" = ${input.authorUserId}::uuid`
         : Prisma.empty}
     ORDER BY m."created_at" DESC
     LIMIT ${input.take}
  `)
  return rows.map((row) => row.id)
}

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
  // Channel and thread *labels* are short and few, so a contains match is fine.
  // Message *content* is the big table: match it through the FTS index
  // (messages_content_fts_idx) instead of an un-indexable ILIKE that scans every
  // message the agent can see.
  const textFilter = { contains: searchQuery, mode: 'insensitive' as const }
  const messageIds = await searchMessageIdsByContent(context, {
    channelIds,
    query: searchQuery,
    take,
  })

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
        team: {
          select: {
            name: true,
            project: { select: { name: true } },
          },
        },
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
            team: {
              select: {
                name: true,
                project: { select: { name: true } },
              },
            },
          },
        },
      },
      take,
    }),
    context.prisma.message.findMany({
      where: { id: { in: messageIds } },
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
                team: {
                  select: {
                    name: true,
                    project: { select: { name: true } },
                  },
                },
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
      `${index + 1}. ${formatChannelRef(channel)} | channelId=${channel.id} | visibility=${channel.visibility} | type=${channel.type}`,
      thread
        ? `   threadId=${thread.id}${thread.title ? ` | thread="${thread.title}"` : ''}`
        : '   threadId=none',
    ].join('\n')
  })
  const threadLines = threads.map((thread, index) =>
    [
      `${index + 1}. ${formatChannelRef(thread.channel)} / ${thread.title ?? '(untitled)'} | threadId=${thread.id}`,
      `   channelId=${thread.channel.id} | visibility=${thread.channel.visibility}`,
    ].join('\n'),
  )
  const messageLines = messages.map((message, index) =>
    formatMessageLine({
      author:
        message.user?.displayName ??
        message.agent?.name ??
        'Unknown',
      channelLabel: formatChannelRef(message.thread.channel),
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
  )
  // Same reasoning as workspace_search: FTS the candidate ids, then hydrate them
  // through the rich select below.
  const messageIds = await searchMessageIdsByContent(context, {
    authorUserId: userId,
    query: searchQuery,
    take,
    visibleChannelWhere,
  })

  const messages = await context.prisma.message.findMany({
    where: { id: { in: messageIds } },
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
            team: {
              select: {
                name: true,
                project: { select: { name: true } },
              },
            },
          },
        },
        },
      },
    },
    take,
  })

  const messageLines = messages.map((message, index) =>
    [
      `${index + 1}. ${formatChannelRef(message.thread.channel)} / ${message.thread.title ?? '(untitled)'}`,
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
