import type { FastifyInstance } from 'fastify'

import { captureUserMessageMemory } from '@nessie/memory'
import {
  CHAT_MESSAGE_MAX_CHARS,
  parseChannelId,
  parseThreadId,
  parseUserId,
  withActionContext,
} from '@nessie/schemas'
import { CreateThreadMessageBodySchema, ThreadMessageRecordSchema } from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { enqueueOrchestrateDecide } from '../queue/pgqueue.js'
import {
  addReaction,
  createThreadMessage,
  findThreadForUser,
  listThreadMessages,
  markThreadRead,
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

    const query = request.query as { before?: string; limit?: string }
    const page = await listThreadMessages(prisma, thread.id, {
      before: query.before,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
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
          contentPreview: result.message.content.slice(0, 200),
          messageId: result.message.id,
          role: result.message.role,
          threadId: parseThreadId(thread.id),
        },
        event: 'message.new',
      },
    )

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
        ThreadMessageRecordSchema.parse({
          id: result.message.id,
          threadId: result.message.threadId,
          agentId: result.message.agentId ?? undefined,
          userId: result.message.userId ?? undefined,
          role: result.message.role,
          content: result.message.content,
          createdAt: result.message.createdAt.toISOString(),
          metadata:
            result.message.metadata
            && typeof result.message.metadata === 'object'
            && !Array.isArray(result.message.metadata)
              ? (result.message.metadata as Record<string, unknown>)
              : undefined,
        }),
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
