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
  ThreadMessageRecordSchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { enqueueOrchestrateDecide, enqueuePushDispatch } from '../queue/pgqueue.js'
import { createThreadMessage } from '../services/message-create.js'
import {
  findThreadForUser,
  mapMessageRecord,
} from '../services/messages.js'
import type { RouteDeps } from './types.js'

export const registerCreateThreadMessageRoute = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const {
    prisma,
    realtimeHub,
    requireActorContext,
    buildChannelRealtimeScopes,
    isPersonalAssistantChannelType,
    messageMemoryCaptureConfig,
  } = deps

  app.post('/api/threads/:threadId/messages', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    // Guard oversized chat bodies before Zod validation so the client can
    // distinguish "too large, offer file upload" from generic validation.
    const rawContent =
      typeof request.body === 'object'
      && request.body !== null
      && 'content' in request.body
      && typeof (request.body as { content: unknown }).content === 'string'
        ? (request.body as { content: string }).content
        : null
    if (rawContent !== null && rawContent.length > CHAT_MESSAGE_MAX_CHARS) {
      reply.status(413).send({
        error: {
          code: 'MESSAGE_TOO_LARGE',
          message:
            `Message is ${rawContent.length} characters; the chat limit is ${CHAT_MESSAGE_MAX_CHARS}.`
            + ' Send as a file instead.',
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

    // Attachment-only posts carry no text; the stored message content is the
    // empty string and the attachments are the payload.
    const content = body.content ?? ''

    const result = await createThreadMessage(prisma, {
      content,
      threadId: thread.id,
      userId: actorContext.actor.actorId,
      rootMessageId: body.rootMessageId,
      alsoSendToChannel: body.alsoSendToChannel,
    })

    if (result.kind === 'thread_not_found') {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }
    if (result.kind === 'invalid_root') {
      sendApiError(
        reply,
        400,
        'INVALID_ROOT_MESSAGE',
        'rootMessageId must reference a top-level message in this thread',
      )
      return reply
    }

    // Link pre-uploaded attachments. Scoped to the sender's own still-unlinked
    // uploads so one member cannot attach another member's pending upload to
    // their message by guessing its id.
    let linkedAttachmentCount = 0
    if (body.attachmentIds && body.attachmentIds.length > 0) {
      const linked = await prisma.attachment.updateMany({
        where: {
          id: { in: body.attachmentIds },
          organizationId: actorContext.tenant.organizationId,
          uploaderId: actorContext.actor.actorId,
          messageId: null,
        },
        data: { messageId: result.message.id },
      })
      // The authoritative count is what actually linked, not what was asked
      // for: an id the sender does not own is silently skipped above.
      linkedAttachmentCount = linked.count
    }

    if (messageMemoryCaptureConfig) {
      // Fire-and-forget: memory capture must never delay message posting.
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
          projectId: actorContext.tenant.projectId,
          teamId:
            actorContext.tenant.teamId
            ?? actorContext.actionContext.teamId,
          sourceAudience: thread.channel.type === 'dm' ? 'dm' : 'channel',
          threadId: thread.id,
          userId: actorContext.actor.actorId,
          sessionId: actorContext.actionContext.sessionId,
          taskId: actorContext.actionContext.taskId,
          agentId: actorContext.actionContext.agentId,
          actorId: actorContext.actor.actorId,
          actorType: actorContext.actor.actorType,
          requestId: actorContext.actionContext.requestId,
          correlationId: actorContext.actionContext.correlationId,
          systemComponent: 'memory-capture',
        },
        messageMemoryCaptureConfig,
      ).catch((error) =>
        request.log.error(
          { err: error, messageId: result.message.id },
          'capture_user_message_memory_failed',
        ),
      )
    }

    const channelScopes = buildChannelRealtimeScopes({
      channelId: thread.channel.id,
      organizationId: actorContext.tenant.organizationId,
      systemChannelType: thread.channel.systemChannelType,
    })

    if (result.replyRoot) {
      // Reply threads (#233): a reply announces itself as `message.reply` (so
      // clients can update the reply panel without touching the top-level
      // feed), followed by the root's fresh materialized metadata.
      await realtimeHub.publishWs(channelScopes, {
        data: {
          agentId: undefined,
          authorUserId: parseUserId(actorContext.actor.actorId),
          channelId: parseChannelId(thread.channel.id),
          contentPreview: result.message.content.slice(0, 200),
          messageId: result.message.id,
          rootMessageId: result.replyRoot.rootMessageId,
          role: result.message.role,
          threadId: parseThreadId(thread.id),
        },
        event: 'message.reply',
      })
      await realtimeHub.publishWs(channelScopes, {
        data: {
          channelId: parseChannelId(thread.channel.id),
          threadId: parseThreadId(thread.id),
          rootMessageId: result.replyRoot.rootMessageId,
          replyCount: result.replyRoot.metadata.replyCount,
          lastReplyAt: result.replyRoot.metadata.lastReplyAt?.toISOString(),
          replyParticipantIds: result.replyRoot.metadata.replyParticipantIds,
        },
        event: 'message.reply.meta',
      })
    } else {
      await realtimeHub.publishWs(channelScopes, {
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
      })
    }

    // "Also send to #channel" copy: a normal top-level `message.new` under the
    // copy's own id. It is informational only — no push/orchestration below.
    if (result.broadcastMessage) {
      await realtimeHub.publishWs(channelScopes, {
        data: {
          agentId: undefined,
          authorUserId: parseUserId(actorContext.actor.actorId),
          channelId: parseChannelId(thread.channel.id),
          contentPreview: result.broadcastMessage.content.slice(0, 200),
          messageId: result.broadcastMessage.id,
          role: result.broadcastMessage.role,
          threadId: parseThreadId(thread.id),
        },
        event: 'message.new',
      })
    }

    // Durable mention alerts were written in the create transaction; fan out
    // one alert.created event per recipient. Best-effort — the rows are the
    // record of truth, a missed event only delays a badge refresh.
    for (const alertedUserId of result.alertedUserIds) {
      try {
        await realtimeHub.publishWs(
          buildChannelRealtimeScopes({
            channelId: thread.channel.id,
            organizationId: actorContext.tenant.organizationId,
            systemChannelType: thread.channel.systemChannelType,
          }),
          {
            data: {
              userId: parseUserId(alertedUserId),
              kind: 'mention' as const,
              messageId: result.message.id,
              threadId: parseThreadId(thread.id),
              channelId: parseChannelId(thread.channel.id),
              actorUserId: parseUserId(actorContext.actor.actorId),
              createdAt: result.message.createdAt.toISOString(),
            },
            event: 'alert.created',
          },
        )
      } catch (error) {
        app.log.error(
          { err: error, messageId: result.message.id, alertedUserId },
          '[alerts] failed to publish alert.created',
        )
      }
    }

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
          rootMessageId: result.replyRoot?.rootMessageId ?? result.message.id,
          organizationId: actorContext.tenant.organizationId,
          contentSnippet: result.message.content.slice(0, 140),
          mentionUserIds,
        },
        `push:${result.message.id}`,
      )
    } catch (error) {
      app.log.error(
        { err: error, messageId: result.message.id },
        '[push] failed to enqueue dispatch job — recipients will not be notified',
      )
    }

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
            content,
            messageId: result.message.id,
            role: result.message.role,
            threadId: parseThreadId(thread.id),
          },
          `orchestrate:${result.message.id}`,
        )
      } catch (error) {
        app.log.error(
          { err: error, messageId: result.message.id },
          '[orchestrate] failed to enqueue decide job — agent will not respond',
        )
      }
    }

    return reply.code(201).send(
      createApiResponse({
        message: ThreadMessageRecordSchema.parse(
          mapMessageRecord(result.message, linkedAttachmentCount),
        ),
        pendingAgentInvites: result.pendingAgentInvites,
      }),
    )
  })
}
