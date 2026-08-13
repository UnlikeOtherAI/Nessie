import type { FastifyInstance } from 'fastify'

import {
  parseThreadId,
} from '@nessie/schemas'
import {
  ListThreadMessagesQuerySchema,
  MarkThreadReadBodySchema,
  RunThinkingLogSchema,
  ThreadMessageRecordSchema,
  ThreadThinkingSchema,
  UpdateThreadMessageBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { buildStreamCorsHeaders } from '../lib/server-context.js'
import { canManageChannel } from '../services/channels.js'
import {
  findThreadForUser,
  listThreadMessages,
  mapMessageRecordWithAttachments,
  markThreadRead,
  softDeleteMessage,
  updateMessage,
} from '../services/messages.js'
import { toggleUserReaction } from '../services/message-reactions.js'
import { loadRunThinkingLog, loadThreadThinking } from '../services/run-thinking.js'
import { registerThreadDocumentStreamRoutes } from './thread-document-streams.js'
import { registerCreateThreadMessageRoute } from './thread-message-create.js'
import { registerThreadReplyRoutes } from './thread-replies.js'
import type { RouteDeps } from './types.js'

export const registerThreadRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    config,
    allowedCorsOrigins,
    prisma,
    realtimeHub,
    requireActorContext,
    buildChannelRealtimeScopes,
  } = deps

  app.get('/api/threads/:threadId/messages', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { threadId } = request.params as { threadId: string }
    const thread = await findThreadForUser(
      prisma,
      threadId,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
    )
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    const query = parseInput(ListThreadMessagesQuerySchema, request.query ?? {}, reply)
    if (!query) {
      return reply
    }
    const page = await listThreadMessages(prisma, thread.id, {
      after: query.after,
      before: query.before,
      limit: query.limit,
      senderId: query.senderId,
      rootMessageId: query.rootMessageId,
      // Disclosure predicate: thread visibility admits the caller to the thread,
      // but a message drawn from sources they cannot reach is still withheld.
      organizationId: actorContext.tenant.organizationId,
      ...(actorContext.actor.actorType === 'user'
        ? { viewerUserId: actorContext.actor.actorId }
        : {}),
    })
    return createApiResponse(
      ThreadMessageRecordSchema.array().parse(page.data),
      page.meta,
    )
  })

  registerCreateThreadMessageRoute(app, deps)
  registerThreadReplyRoutes(app, deps)
  // Live document composition (bootstrap + address-bar retarget). Split out for
  // the same reason as the two above: this module is at its size budget.
  registerThreadDocumentStreamRoutes(app, deps)

  // ─── Agent thought process ────────────────────────────────────────────────
  // Both routes gate on thread visibility exactly like the SSE stream route
  // below, then require the run to belong to that thread — a run from another
  // thread is indistinguishable from a missing one.
  app.get('/api/threads/:threadId/thinking', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { threadId } = request.params as { threadId: string }
    const thread = await findThreadForUser(
      prisma,
      threadId,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
    )
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    return createApiResponse(
      ThreadThinkingSchema.parse(await loadThreadThinking(prisma, thread.id)),
    )
  })

  app.get('/api/threads/:threadId/runs/:runId/thinking', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { threadId, runId } = request.params as { threadId: string; runId: string }
    const thread = await findThreadForUser(
      prisma,
      threadId,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
    )
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    const log = await loadRunThinkingLog(prisma, { runId, threadId: thread.id })
    if (!log) {
      sendApiError(reply, 404, 'RUN_NOT_FOUND', 'Run not found')
      return reply
    }

    return createApiResponse(RunThinkingLogSchema.parse(log))
  })

  app.post('/api/threads/:threadId/read', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { threadId } = request.params as { threadId: string }
    const thread = await findThreadForUser(
      prisma,
      threadId,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
    )
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    const body = parseInput(MarkThreadReadBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const marked = await markThreadRead(prisma, {
      rootMessageId: body.rootMessageId,
      threadId: thread.id,
      userId: actorContext.actor.actorId,
    })
    if (!marked) {
      sendApiError(reply, 404, 'REPLY_ROOT_NOT_FOUND', 'Reply conversation not found')
      return reply
    }

    return reply.code(200).send(createApiResponse({ ok: true }))
  })

  app.post('/api/threads/:threadId/messages/:messageId/reactions', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { threadId, messageId } = request.params as { threadId: string; messageId: string }
    const thread = await findThreadForUser(
      prisma,
      threadId,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
    )
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    const body = request.body as { emoji?: string } | undefined
    if (!body?.emoji) {
      sendApiError(reply, 400, 'EMOJI_REQUIRED', 'Emoji is required')
      return reply
    }

    const reaction = await toggleUserReaction(prisma, {
      messageId,
      threadId: thread.id,
      userId: actorContext.actor.actorId,
      emoji: body.emoji,
    })
    if (reaction.kind === 'not_found') {
      sendApiError(reply, 404, 'MESSAGE_NOT_FOUND', 'Message not found')
      return reply
    }

    await realtimeHub.publishWs(
      buildChannelRealtimeScopes({
        channelId: thread.channel.id,
        organizationId: actorContext.tenant.organizationId,
        systemChannelType: thread.channel.systemChannelType,
      }),
      {
        data: { messageId, userId: actorContext.actor.actorId, emoji: body.emoji },
        event: 'message.reaction',
      },
    )

    return reply
      .code(reaction.kind === 'created' ? 201 : 200)
      .send(createApiResponse({ ok: true }))
  })

  // ─── sp-messaging slice: edit + soft-delete ──────────────────────────────
  app.patch('/api/threads/:threadId/messages/:messageId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { threadId, messageId } = request.params as {
      threadId: string
      messageId: string
    }
    const thread = await findThreadForUser(
      prisma,
      threadId,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
    )
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    const body = parseInput(UpdateThreadMessageBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const result = await updateMessage(prisma, {
      content: body.content,
      messageId,
      threadId: thread.id,
      userId: actorContext.actor.actorId,
    })
    if (result.kind === 'not_found') {
      sendApiError(reply, 404, 'MESSAGE_NOT_FOUND', 'Message not found')
      return reply
    }
    if (result.kind === 'forbidden') {
      sendApiError(reply, 403, 'FORBIDDEN', 'Only the author can edit this message')
      return reply
    }

    const record = await mapMessageRecordWithAttachments(prisma, result.message)
    await realtimeHub.publishWs(
      buildChannelRealtimeScopes({
        channelId: thread.channel.id,
        organizationId: actorContext.tenant.organizationId,
        systemChannelType: thread.channel.systemChannelType,
      }),
      {
        data: {
          contentPreview: record.content.slice(0, 200),
          editedAt: record.editedAt ?? new Date().toISOString(),
          messageId: record.id,
          threadId: parseThreadId(thread.id),
        },
        event: 'message.updated',
      },
    )

    return createApiResponse(ThreadMessageRecordSchema.parse(record))
  })

  app.delete('/api/threads/:threadId/messages/:messageId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { threadId, messageId } = request.params as {
      threadId: string
      messageId: string
    }
    const thread = await findThreadForUser(
      prisma,
      threadId,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
    )
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    // Channel/team/org managers (and the author) may delete a message. Uses the
    // same authorization as the channel_* agent tools so REST and agents agree.
    const manage = await canManageChannel(prisma, {
      channelId: thread.channel.id,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    const isChannelManager = manage !== null
    const result = await softDeleteMessage(prisma, {
      isChannelManager,
      messageId,
      threadId: thread.id,
      userId: actorContext.actor.actorId,
    })
    if (result.kind === 'not_found') {
      sendApiError(reply, 404, 'MESSAGE_NOT_FOUND', 'Message not found')
      return reply
    }
    if (result.kind === 'forbidden') {
      sendApiError(
        reply,
        403,
        'FORBIDDEN',
        'Only the author or a channel manager can delete this message',
      )
      return reply
    }

    const record = await mapMessageRecordWithAttachments(prisma, result.message)
    await realtimeHub.publishWs(
      buildChannelRealtimeScopes({
        channelId: thread.channel.id,
        organizationId: actorContext.tenant.organizationId,
        systemChannelType: thread.channel.systemChannelType,
      }),
      {
        data: {
          deletedAt: record.deletedAt ?? new Date().toISOString(),
          messageId: record.id,
          threadId: parseThreadId(thread.id),
        },
        event: 'message.deleted',
      },
    )

    return createApiResponse(ThreadMessageRecordSchema.parse(record))
  })

  app.get('/api/threads/:threadId/stream', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { threadId } = request.params as { threadId: string }
    const thread = await findThreadForUser(
      prisma,
      threadId,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
    )
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    reply.hijack()
    reply.raw.writeHead(200, {
      ...buildStreamCorsHeaders({
        origin: request.headers.origin,
        allowedOrigins: allowedCorsOrigins,
        mode: config.mode,
      }),
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
      // Token-by-token delivery only survives if no hop buffers the response:
      // the proxy hint plus Nagle off, matching streamDesignerChat.
      'X-Accel-Buffering': 'no',
    })
    reply.raw.socket?.setNoDelay(true)
    reply.raw.write(': stream connected\n\n')

    const lastEventIdHeader = request.headers['last-event-id']
    const lastEventId = Array.isArray(lastEventIdHeader)
      ? lastEventIdHeader[0]
      : lastEventIdHeader

    // Register cleanup BEFORE awaiting addSseConnection so a half-open socket
    // is still torn down if the client disconnects mid-await.
    const keepAlive = setInterval(() => {
      reply.raw.write(': keepalive\n\n')
    }, 15000)

    let streamConnection: Awaited<ReturnType<typeof realtimeHub.addSseConnection>> | null = null
    let socketClosed = false
    request.raw.on('close', () => {
      socketClosed = true
      clearInterval(keepAlive)
      if (streamConnection) {
        realtimeHub.removeSseConnection(streamConnection)
      }
      reply.raw.end()
    })

    try {
      streamConnection = await realtimeHub.addSseConnection(
        thread.id,
        reply.raw,
        lastEventId,
      )
      // If the socket closed during hydration the close handler fired with
      // streamConnection still null — remove now to avoid orphaning the
      // connection inside the hub.
      if (socketClosed) {
        realtimeHub.removeSseConnection(streamConnection)
      }
    } catch (err) {
      clearInterval(keepAlive)
      reply.raw.end()
      request.log.error({ err }, 'sse_setup_failed')
      return reply
    }
  })
}
