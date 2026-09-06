import type { FastifyInstance } from 'fastify'

import {
  detectSecrets,
  parseOrganizationId,
  parseThreadId,
  parseUserId,
} from '@nessie/schemas'
import {
  ListThreadMessagesQuerySchema,
  MarkThreadReadBodySchema,
  RunThinkingLogSchema,
  ThreadMessageRecordSchema,
  ThreadThinkingSchema,
  ToggleMessageReactionBodySchema,
  UpdateThreadMessageBodySchema,
} from '../contracts/messaging.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { canManageChannel } from '../services/channels.js'
import { softDeleteMessage, updateMessage } from '../services/message-edit.js'
import {
  listThreadMessages,
  mapMessageRecordWithAttachments,
} from '../services/message-read-model.js'
import { findThreadForUser, markThreadRead } from '../services/message-read-state.js'
import { toggleUserReaction } from '../services/message-reactions.js'
import { loadRunThinkingLog, loadThreadThinking } from '../services/run-thinking.js'
import { canUserReadRunBasis } from '../services/run-disclosure.js'
import { registerThreadDocumentStreamRoutes } from './thread-document-streams.js'
import { registerCreateThreadMessageRoute } from './thread-message-create.js'
import { registerThreadReplyRoutes } from './thread-replies.js'
import { registerThreadActivityRoutes } from './thread-activity.js'
import { registerThreadStreamRoute } from './thread-stream.js'
import { registerUnreadDirectMessageRoutes } from './unread-direct-messages.js'
import type { RouteDeps } from './types.js'

export const registerThreadRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    realtimeHub,
    requireActorContext,
    buildChannelRealtimeScopes,
  } = deps

  registerThreadActivityRoutes(app, deps)
  registerUnreadDirectMessageRoutes(app, deps)

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
      ThreadThinkingSchema.parse(
        await loadThreadThinking(prisma, thread.id, {
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
        }),
      ),
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

    // The thought log inherits the reply's provenance: a viewer withheld the
    // restricted answer must not read the reasoning that produced it. Answering
    // 404 (rather than 403) keeps this consistent with the route's existing
    // "do not confirm what you cannot see" behaviour above.
    const readable = await canUserReadRunBasis(prisma, {
      organizationId: actorContext.tenant.organizationId,
      runId,
      userId: actorContext.actor.actorId,
    })
    if (!readable) {
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
      organizationId: actorContext.tenant.organizationId,
      rootMessageId: body.rootMessageId,
      lastReadMessageId: body.lastReadMessageId,
      threadId: thread.id,
      userId: actorContext.actor.actorId,
    })
    if (!marked) {
      sendApiError(reply, 404, 'REPLY_ROOT_NOT_FOUND', 'Reply conversation not found')
      return reply
    }

    // Read state is per person. Deliver a durable, recipient-private event so
    // their other sessions refresh immediately without exposing a read receipt
    // to every channel participant.
    await realtimeHub.publishWs([
      { kind: 'organization', organizationId: actorContext.tenant.organizationId },
      {
        kind: 'user',
        organizationId: parseOrganizationId(actorContext.tenant.organizationId),
        userId: parseUserId(actorContext.actor.actorId),
      },
    ], {
      data: { rootMessageId: body.rootMessageId, threadId: thread.id },
      event: 'thread.read',
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

    const body = parseInput(ToggleMessageReactionBodySchema, request.body, reply)
    if (!body) return reply

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
    if (detectSecrets(body.content).length > 0) {
      sendApiError(
        reply,
        422,
        'SECRET_INTERCEPTED',
        'A possible credential was intercepted before this message was saved. Save it through Secrets instead.',
      )
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
    if (result.kind === 'immutable') {
      sendApiError(
        reply,
        409,
        'MESSAGE_IMMUTABLE_CARD_RESPONSE',
        'This message records a card response and cannot be edited. Delete it instead, or ask the agent to post a new card.',
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

    // A channel manager may delete a message they were never entitled to read,
    // so the record echoed back to them goes through the disclosure predicate
    // like any other read.
    const record = await mapMessageRecordWithAttachments(prisma, result.message, {
      channelId: thread.channel.id,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
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

  // Live SSE stream (messages/thinking/document events). Split into its own
  // module — see thread-stream.ts for why it registers by viewer, not thread id.
  registerThreadStreamRoute(app, deps)
}
