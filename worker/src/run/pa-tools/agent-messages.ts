import { Prisma } from '@prisma/client'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { resolveAccessibleChannelIds } from './access.js'
import {
  recordMessageChannelRead,
  UNRESTRICTED_MESSAGES_ONLY,
} from './message-search-basis.js'
import {
  buildSnippet,
  clampLimit,
  formatMessageLine,
  formatSection,
  MAX_SEARCH_RESULTS,
} from './tool-output.js'

type MessageSearchRow = {
  id: string
  thread_id: string
  channel_id: string
  channel_label: string
  channel_visibility: string
  content: string
  created_at: Date
  author_name: string | null
  project_name: string
  team_name: string
  root_message_id: string | null
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
      m."root_message_id",
      c."id" AS channel_id,
      c."label" AS channel_label,
      c."visibility" AS channel_visibility,
      p."name" AS project_name,
      tm."name" AS team_name,
      m."content",
      m."created_at",
      COALESCE(u."display_name", a."name") AS author_name
    FROM "messages" m
    JOIN "threads" t ON t."id" = m."thread_id"
    JOIN "channels" c ON c."id" = t."channel_id"
    JOIN "teams" tm ON tm."id" = c."team_id"
    JOIN "projects" p ON p."id" = tm."project_id"
    LEFT JOIN "users" u ON u."id" = m."user_id"
    LEFT JOIN "agents" a ON a."id" = m."agent_id"
    WHERE m."deleted_at" IS NULL
      AND t."channel_id" IN (${Prisma.join(
        // `threads.channel_id` is `uuid`; Prisma sends a bare string parameter
        // as `text`, and Postgres has no `uuid = text` operator, so an uncast
        // list fails the whole query with 42883 at runtime. Cast each element,
        // matching `conversation-search.ts`.
        channelIds.map((id) => Prisma.sql`${id}::uuid`),
      )})
      AND to_tsvector('english', m."content") @@ plainto_tsquery('english', ${searchQuery})
      AND ${UNRESTRICTED_MESSAGES_ONLY}
    ORDER BY m."created_at" DESC
    LIMIT ${take}
  `)

  // The snippets below are content from these channels, so the run's reply
  // inherits their scope.
  recordMessageChannelRead(
    context,
    rows.map((row) => ({ id: row.channel_id, visibility: row.channel_visibility })),
  )

  const lines = rows.map((row, index) =>
    formatMessageLine({
      author: row.author_name ?? 'Unknown',
      channelId: row.channel_id,
      channelLabel: `#${row.channel_label} (${row.project_name} / ${row.team_name})`,
      createdAt: row.created_at.toISOString(),
      messageId: row.id,
      rootMessageId: row.root_message_id,
      snippet: buildSnippet(row.content, searchQuery),
      threadId: row.thread_id,
      threadLabel: null,
    }).replace(/^-\s/, `${index + 1}. `),
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

/**
 * React to a message — the same emoji buttons a person clicks.
 *
 * A reaction is how a colleague says "seen", "agreed", "on it" without adding
 * a message nobody needs to read. Reacting is a real reaction row, not an
 * emoji typed into a reply: text renders as text, and a paragraph containing
 * 👍 is still a paragraph.
 *
 * Scoped to messages the run can already reach — the same accessible-channel
 * set that governs conversation search — so an agent cannot annotate a
 * conversation it could not read.
 */
export const runReactTool = async (
  context: BuiltinToolRuntimeContext,
  input: { messageId: string; emoji: string; remove?: boolean },
): Promise<ToolExecutionResult> => {
  const emoji = input.emoji.trim()
  if (!input.messageId) {
    throw new Error('messageId is required.')
  }
  if (!emoji) {
    throw new Error('emoji is required.')
  }
  if ([...emoji].length > 8) {
    throw new Error('emoji must be a single emoji, not text.')
  }

  const channelIds = await resolveAccessibleChannelIds(context)
  const message = channelIds.length
    ? await context.prisma.message.findFirst({
        select: { id: true, threadId: true },
        where: {
          deletedAt: null,
          id: input.messageId,
          thread: { channelId: { in: channelIds } },
        },
      })
    : null
  if (!message) {
    throw new Error('Message not found in a conversation this agent can see.')
  }

  const summary = `messageId=${input.messageId} emoji=${emoji}`
  if (input.remove) {
    await context.prisma.messageReaction.deleteMany({
      where: { agentId: context.agentId, emoji, messageId: message.id },
    })
    return {
      inputSummary: summary,
      outputPreview: `Removed ${emoji} from messageId=${message.id}`,
      toolName: 'react',
    }
  }

  await context.prisma.messageReaction.upsert({
    create: { agentId: context.agentId, emoji, messageId: message.id },
    update: {},
    where: {
      messageId_agentId_emoji: {
        agentId: context.agentId,
        emoji,
        messageId: message.id,
      },
    },
  })
  return {
    inputSummary: summary,
    outputPreview: `Reacted ${emoji} to messageId=${message.id}`,
    toolName: 'react',
  }
}
