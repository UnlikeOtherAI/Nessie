import type { FastifyInstance } from 'fastify'

import {
  CHAT_MESSAGE_MAX_CHARS,
  detectSecrets,
  parseAgentId,
  parseUserId,
} from '@nessie/schemas'
import {
  CreateThreadMessageBodySchema,
  ThreadMessageRecordSchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { createThreadMessage } from '../services/message-create.js'
import { deliverCreatedMessage } from '../services/message-delivery.js'
import {
  mapMessageRecord,
  mapMessageRecordWithAttachments,
} from '../services/message-read-model.js'
import { findThreadForUser } from '../services/message-read-state.js'
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
    const detectedSecrets = detectSecrets(content)
    if (detectedSecrets.length > 0) {
      // This is deliberately before message creation, memory capture, model
      // dispatch, websocket previews, and any application logging of content.
      // The client uses the same structural scanner, but the server remains
      // the authoritative containment boundary for pasted or bypassed input.
      sendApiError(
        reply,
        422,
        'SECRET_INTERCEPTED',
        'Nessie did not send this message because it contains a credential. Save it through Secrets instead.',
      )
      return reply
    }

    // Idempotency key: the body field wins, the `Idempotency-Key` header is the
    // transport-level spelling of the same thing. Either way it scopes to this
    // thread, so one draft retried cannot become two messages.
    const headerKey = request.headers['idempotency-key']
    const clientMessageId =
      body.clientMessageId
      ?? (typeof headerKey === 'string' && headerKey.trim().length > 0
        ? headerKey.trim().slice(0, 200)
        : undefined)

    const result = await createThreadMessage(prisma, {
      content,
      threadId: thread.id,
      userId: actorContext.actor.actorId,
      ...(clientMessageId ? { clientMessageId } : {}),
      rootMessageId: body.rootMessageId,
      alsoSendToChannel: body.alsoSendToChannel,
      agentMentions: body.agentMentions?.map((mention) => ({
        agentId: parseAgentId(mention.agentId),
        ...(mention.principalUserId
          ? { principalUserId: parseUserId(mention.principalUserId) }
          : {}),
        type: mention.type,
      })),
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
    if (result.kind === 'replayed') {
      // The first attempt already created this message, linked its attachments,
      // alerted, pushed and dispatched. Replaying those would double every one
      // of them, so the retry only gets the message back.
      return reply.code(200).send(
        createApiResponse({
          message: ThreadMessageRecordSchema.parse(
            await mapMessageRecordWithAttachments(prisma, result.message),
          ),
          pendingAgentInvites: [],
        }),
      )
    }
    if (result.kind === 'invalid_agent_mention') {
      sendApiError(
        reply,
        400,
        'INVALID_AGENT_MENTION',
        'That agent is not available in this channel',
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

    // Everything past the row — memory, realtime, alerts, push, and the run
    // this message starts — is one shared step, because the voice call's
    // `pa_send` posts as the person too and a second copy of it would drift.
    await deliverCreatedMessage(
      { buildChannelRealtimeScopes, messageMemoryCaptureConfig, prisma, realtimeHub },
      { actorContext, content, log: request.log, result, thread },
    )

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
