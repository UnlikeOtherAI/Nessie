import type { FastifyInstance } from 'fastify'

import { captureUserMessageMemory } from '@nessie/memory'
import {
  CHAT_MESSAGE_MAX_CHARS,
  parseChannelId,
  parseThreadId,
  parseUserId,
  withActionContext,
} from '@nessie/schemas'
import {
  CreateThreadMessageBodySchema,
  ListThreadMessagesQuerySchema,
  ThreadMessageRecordSchema,
  UpdateThreadMessageBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { enqueueOrchestrateDecide, enqueuePushDispatch } from '../queue/pgqueue.js'
import { canManageChannel } from '../services/channels.js'
import {
  addReaction,
  createThreadMessage,
  findThreadForUser,
  listThreadMessages,
  mapMessageRecord,
  markThreadRead,
  softDeleteMessage,
  updateMessage,
} from '../services/messages.js'
import type { RouteDeps } from './types.js'

export const registerThreadRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    realtimeHub,
    requireActorContext,
    buildChannelRealtimeScopes,
    isPersonalAssistantChannelType,
    messageMemoryCaptureConfig,
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
    })
    return createApiResponse(
      ThreadMessageRecordSchema.array().parse(page.data),
      page.meta,
    )
  })

  app.post('/api/threads/:threadId/messages', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    // Guard oversized chat bodies BEFORE Zod validation so the client can
    // distinguish "too large, offer file upload" from generic validation
    // failures. Checked on the raw body.
    const rawContent =
      typeof request.body === 'object' &&
      request.body !== null &&
      'content' in request.body &&
      typeof (request.body as { content: unknown }).content === 'string'
        ? (request.body as { content: string }).content
        : null
    if (rawContent !== null && rawContent.length > CHAT_MESSAGE_MAX_CHARS) {
      reply.status(413).send({
        error: {
          code: 'MESSAGE_TOO_LARGE',
          message:
            `Message is ${rawContent.length} characters; the chat limit is ${CHAT_MESSAGE_MAX_CHARS}.` +
            ' Send as a file instead.',
          limit: CHAT_MESSAGE_MAX_CHARS,
          length: rawContent.length,
        },
      })
      return reply
    }

    const body = parseInput(CreateThreadMessageBodySchema, request.body, reply)
    if (!body) {
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

    const result = await createThreadMessage(prisma, {
      content: body.content,
      threadId: thread.id,
      userId: actorContext.actor.actorId,
    })

    if (result.kind === 'thread_not_found') {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    // ─── Attachments (files slice) ──────────────────────────────────────────
    // Link any pre-uploaded attachments to this message, scoped to the actor's
    // organization so a stray id cannot poach another tenant's attachment.
    if (body.attachmentIds && body.attachmentIds.length > 0) {
      await prisma.attachment.updateMany({
        where: {
          id: { in: body.attachmentIds },
          organizationId: actorContext.tenant.organizationId,
          messageId: null,
        },
        data: { messageId: result.message.id },
      })
    }

    if (messageMemoryCaptureConfig) {
      // Fire-and-forget: never block the message POST response on memory
      // capture. The handler comment downstream asserts orchestration "never
      // blocks this response" — keep that invariant here too.
      void captureUserMessageMemory(
        {
          channelId: thread.channel.id,
          content: result.message.content,
          memoryOrigin:
            thread.channel.systemChannelType === 'personal_assistant'
              ? 'personal_assistant_dm'
              : 'user_authored_workspace_message',
          messageId: result.message.id,
          organizationId: actorContext.tenant.organizationId,
          sourceAudience: thread.channel.type === 'dm' ? 'dm' : 'channel',
          threadId: thread.id,
          userId: actorContext.actor.actorId,
        },
        messageMemoryCaptureConfig,
      ).catch((err) =>
        request.log.error(
          { err, messageId: result.message.id },
          'capture_user_message_memory_failed',
        ),
      )
    }

    await realtimeHub.publishWs(
      buildChannelRealtimeScopes({
        channelId: thread.channel.id,
        organizationId: actorContext.tenant.organizationId,
        systemChannelType: thread.channel.systemChannelType,
      }),
      {
        data: {
          agentId: undefined,
          authorUserId: parseUserId(actorContext.actor.actorId),
          channelId: parseChannelId(thread.channel.id),
          contentPreview: result.message.content.slice(0, 200),
          messageId: result.message.id,
          role: result.message.role,
          threadId: parseThreadId(thread.id),
        },
        event: 'message.new',
      },
    )

    // Enqueue push dispatch — fan APNs/FCM notifications out to the other
    // channel members' devices. Fire-and-forget: a push failure must NEVER
    // break message posting, so a transient queue-insert error is logged and
    // swallowed here exactly like the orchestrate enqueue below.
    try {
      const mentions =
        result.message.metadata
        && typeof result.message.metadata === 'object'
        && !Array.isArray(result.message.metadata)
          ? (result.message.metadata as { mentions?: { userIds?: unknown } }).mentions
          : undefined
      const mentionUserIds =
        mentions && Array.isArray(mentions.userIds)
          ? mentions.userIds.filter((id): id is string => typeof id === 'string')
          : []
      await enqueuePushDispatch(
        prisma,
        {
          messageId: result.message.id,
          authorUserId: actorContext.actor.actorId,
          channelId: thread.channel.id,
          threadId: thread.id,
          organizationId: actorContext.tenant.organizationId,
          contentSnippet: result.message.content.slice(0, 140),
          mentionUserIds,
        },
        `push:${result.message.id}`,
      )
    } catch (err) {
      app.log.error(
        { err, messageId: result.message.id },
        '[push] failed to enqueue dispatch job — recipients will not be notified',
      )
    }

    // Enqueue agent-engagement decision — durable, retryable, never blocks this
    // response. The try/catch ensures a transient queue-insert failure cannot
    // surface as a "failed" badge on an already-persisted user message.
    if (result.channelAgents.length > 0) {
      const orchestrationActorContext = isPersonalAssistantChannelType(
        thread.channel.systemChannelType,
      )
        ? withActionContext(actorContext, {
            effectiveUserId: parseUserId(actorContext.actor.actorId),
          })
        : actorContext

      try {
        await enqueueOrchestrateDecide(
          prisma,
          {
            actorContext: orchestrationActorContext,
            channelAgents: result.channelAgents,
            channelId: parseChannelId(thread.channel.id),
            content: body.content,
            messageId: result.message.id,
            role: result.message.role,
            threadId: parseThreadId(thread.id),
          },
          `orchestrate:${result.message.id}`,
        )
      } catch (err) {
        app.log.error(
          { err, messageId: result.message.id },
          '[orchestrate] failed to enqueue decide job — agent will not respond',
        )
      }
    }

    return reply.code(201).send(
      createApiResponse(
        ThreadMessageRecordSchema.parse(mapMessageRecord(result.message)),
      ),
    )
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

    await markThreadRead(prisma, {
      threadId: thread.id,
      userId: actorContext.actor.actorId,
    })

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

    await addReaction(prisma, {
      messageId,
      userId: actorContext.actor.actorId,
      emoji: body.emoji,
    })

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

    return reply.code(201).send(createApiResponse({ ok: true }))
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

    const record = mapMessageRecord(result.message)
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

    const record = mapMessageRecord(result.message)
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
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
    })
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
