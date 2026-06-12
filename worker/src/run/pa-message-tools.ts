import { Prisma } from '@prisma/client'
import { captureUserMessageMemory } from '@nessie/memory'
import { CHAT_MESSAGE_MAX_CHARS, withActionContext } from '@nessie/schemas'
import { parseChannelId, parseThreadId, parseUserId } from '@nessie/schemas'
import { enqueueQueueJob } from '../queue.js'
import { resolveAccessibleChannelIds, requireActingUserId } from './pa-tool-access.js'
import {
  buildSnippet,
  clampLimit,
  formatSection,
  MAX_SEARCH_RESULTS,
  truncate,
} from './pa-tool-format.js'
import {
  buildRealtimeScopesForChannel,
  resolveMessageDestination,
} from './pa-message-destination.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from './tool-types.js'

export const runSendMessageTool = async (
  context: BuiltinToolRuntimeContext,
  input: {
    channelId?: string
    content: string
    targetUserId?: string
    threadId?: string
  },
): Promise<ToolExecutionResult> => {
  const userId = requireActingUserId(context)
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
      `channelId=${destination.channelId} | channel="${destination.channelLabel}" | scope="${destination.channelScope}"`,
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
  project_name: string
  team_name: string
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
      AND t."channel_id" IN (${Prisma.join(channelIds)})
      AND to_tsvector('english', m."content") @@ plainto_tsquery('english', ${searchQuery})
    ORDER BY m."created_at" DESC
    LIMIT ${take}
  `)

  const lines = rows.map((row, index) =>
    [
      `${index + 1}. ${row.author_name ?? 'Unknown'} | #${row.channel_label} (${row.project_name} / ${row.team_name})`,
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
