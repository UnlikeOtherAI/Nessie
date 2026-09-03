import type { FastifyInstance, RouteShorthandOptions } from 'fastify'

import {
  detectSecrets,
  VoiceAssistantRepliesQuerySchema,
  VoiceAssistantRepliesResponseSchema,
  VoiceSendToAssistantRequestSchema,
  VoiceSendToAssistantResponseSchema,
} from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { createThreadMessage } from '../services/message-create.js'
import { deliverCreatedMessage } from '../services/message-delivery.js'
import { findThreadForUser, listThreadMessages } from '../services/messages.js'
import { requireActiveSession } from '../services/voice/voice-session.js'
import { sendVoiceError } from './voice-route-errors.js'

import type { RouteDeps } from './types.js'

/**
 * The call's conversation bridge: handing work to the assistant, and hearing
 * back.
 *
 * A live call answers in seconds; a real run takes minutes. `pa_send` is the
 * seam between the two — it posts what the person asked for as an ordinary
 * message in the call's own DM, and the reply is spoken later as its own turn.
 *
 * Both routes exist because the *native* client cannot use the generic message
 * routes: the voice-scoped device credential is refused there on purpose, so a
 * stolen phone token cannot write to an arbitrary thread. These are the narrow
 * equivalents, and what makes the scope real is that the thread is never named
 * by the caller — it is the one the call was minted against.
 *
 * Nothing here adds authority. The message is written as the person, through
 * the same `createThreadMessage` + `deliverCreatedMessage` path the composer
 * uses, so approvals, policy and disclosure all apply unchanged; and the reply
 * poll is an ordinary viewer-entitled read.
 */
export const registerVoiceConversationRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
  /** The voice-credential scope marker, granted by the subsystem's front door. */
  duringACall: RouteShorthandOptions,
): void => {
  const {
    buildChannelRealtimeScopes,
    messageMemoryCaptureConfig,
    prisma,
    realtimeHub,
    requireActorContext,
    requireUserActor,
  } = deps

  /**
   * Hands a spoken request to the assistant's own longer-running self.
   *
   * The `rootMessageId` in the answer is where to listen: a run triggered by a
   * top-level message replies *into that message's reply thread*, so the
   * hand-off's own id is the anchor for everything that follows it.
   */
  app.post('/api/voice/sessions/:sessionId/pa-send', duringACall, async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !requireUserActor(actorContext, reply)) return reply
    const { sessionId } = request.params as { sessionId: string }

    const body = parseInput(VoiceSendToAssistantRequestSchema, request.body ?? {}, reply)
    if (!body) return reply

    try {
      const session = await requireActiveSession(prisma, {
        organizationId: actorContext.tenant.organizationId,
        sessionId,
        userId: actorContext.actor.actorId,
      })

      // NEUTRALIZED The call's own thread, never a thread the client named — and read
      // through the ordinary visibility check, so a person who lost access to
      // the channel mid-call cannot still post into it.
      const thread = await findThreadForUser(
        prisma,
        session.threadId,
        actorContext.actor.actorId,
        actorContext.tenant.organizationId,
      )
      if (!thread) {
        return sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      }

      // The same containment boundary a typed message crosses. A credential
      // read aloud is unlikely and this is cheap; the point is that the voice
      // path is not a way around a gate the composer cannot get around.
      if (detectSecrets(body.text).length > 0) {
        return sendApiError(
          reply,
          422,
          'SECRET_INTERCEPTED',
          'Nessie did not send this because it contains a credential.',
        )
      }

      // The per-call ceiling covers this as it covers every other tool: a
      // hand-off is a model-chosen action that starts a real, billable run,
      // and the ceiling is the only bound on how much work one call can start.
      // Its own result is a fixed ack rather than context the model re-sends,
      // so it is counted for the run it begins, not for what it returns.
      if (session.toolCallCount >= session.maxToolCalls) {
        return sendApiError(
          reply,
          429,
          'VOICE_TOOL_LIMIT',
          'This call has used all the tool calls it is allowed.',
        )
      }

      // Gemini retries a tool call it did not see answered, so the provider's
      // own call id arrives as the transport spelling of an idempotency key —
      // exactly as it does on the generic route.
      const headerKey = request.headers['idempotency-key']
      const clientMessageId =
        typeof headerKey === 'string' && headerKey.trim().length > 0
          ? headerKey.trim().slice(0, 200)
          : undefined

      const result = await createThreadMessage(prisma, {
        content: body.text,
        threadId: thread.id,
        userId: actorContext.actor.actorId,
        ...(clientMessageId ? { clientMessageId } : {}),
      })

      if (result.kind === 'replayed') {
        // The retry gets the message the first attempt made. Delivering it a
        // second time would double the run, the push and the announcement.
        return reply.code(200).send(createApiResponse(handoffResponse(result.message)))
      }
      if (result.kind !== 'created') {
        // The thread went away between the visibility check and the write. The
        // other refusals cannot occur here: this posts a plain top-level
        // message with no root and no mentions to validate.
        return sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      }

      await prisma.voiceSession.update({
        where: { id: session.id },
        data: { toolCallCount: { increment: 1 } },
      })

      await deliverCreatedMessage(
        { buildChannelRealtimeScopes, messageMemoryCaptureConfig, prisma, realtimeHub },
        {
          actorContext,
          content: body.text,
          log: request.log,
          result,
          thread,
        },
      )

      return reply.code(201).send(createApiResponse(handoffResponse(result.message)))
    } catch (error) {
      return sendVoiceError(reply, error) ?? Promise.reject(error)
    }
  })

  /**
   * What the assistant has said since a hand-off.
   *
   * Polled rather than streamed, deliberately: a run that consumed a
   * privileged source has its live lane cut structurally, so the thread stream
   * can silently never deliver the very answer this call is waiting for. A
   * viewer-entitled read always answers correctly — with the reply when the
   * caller may see it, and without it when they may not.
   */
  app.get('/api/voice/sessions/:sessionId/replies', duringACall, async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { sessionId } = request.params as { sessionId: string }

    const query = parseInput(VoiceAssistantRepliesQuerySchema, request.query ?? {}, reply)
    if (!query) return reply

    try {
      const session = await requireActiveSession(prisma, {
        organizationId: actorContext.tenant.organizationId,
        sessionId,
        userId: actorContext.actor.actorId,
      })

      // Scoped to the call's thread, so `after` cannot be used to read the
      // position of a message in a conversation this call is not part of.
      const anchor = await prisma.message.findFirst({
        where: { id: query.after, threadId: session.threadId },
        select: { createdAt: true, id: true, rootMessageId: true },
      })
      if (!anchor) {
        return sendApiError(reply, 404, 'VOICE_REPLY_ANCHOR_NOT_FOUND', 'Message not found.')
      }

      const replies = await readAssistantReplies(prisma, {
        anchor,
        organizationId: actorContext.tenant.organizationId,
        threadId: session.threadId,
        viewerUserId: actorContext.actor.actorId,
      })

      return createApiResponse(VoiceAssistantRepliesResponseSchema.parse({ replies }))
    } catch (error) {
      return sendVoiceError(reply, error) ?? Promise.reject(error)
    }
  })
}

/** How many messages back one poll looks. A call speaks the first answer. */
const REPLY_PAGE_SIZE = 20

const handoffResponse = (
  message: { id: string; rootMessageId: string | null },
): { messageId: string; rootMessageId: string } =>
  VoiceSendToAssistantResponseSchema.parse({
    messageId: message.id,
    // A top-level message is the root of the reply thread the run will answer
    // in, so for a hand-off these are the same id. Stated rather than assumed,
    // because it is what the client polls against.
    rootMessageId: message.rootMessageId ?? message.id,
  })

/**
 * Assistant messages that landed after the hand-off, in both lanes.
 *
 * A run answers in its trigger's reply thread by default, but a run that
 * judged its answer a standalone contribution posts top-level instead. Reading
 * one lane would silently lose the other half of the time, and a lost answer
 * is an answer the call never speaks.
 */
const readAssistantReplies = async (
  prisma: Parameters<typeof listThreadMessages>[0],
  input: {
    anchor: { createdAt: Date; id: string; rootMessageId: string | null }
    organizationId: string
    threadId: string
    viewerUserId: string
  },
): Promise<{ createdAt: string; messageId: string; text: string }[]> => {
  const shared = {
    after: input.anchor.createdAt.toISOString(),
    limit: REPLY_PAGE_SIZE,
    organizationId: input.organizationId,
    viewerUserId: input.viewerUserId,
  }
  const replyRoot = input.anchor.rootMessageId ?? input.anchor.id
  const [topLevel, inReplyThread] = await Promise.all([
    listThreadMessages(prisma, input.threadId, shared),
    listThreadMessages(prisma, input.threadId, { ...shared, rootMessageId: replyRoot }),
  ])

  return [...topLevel.data, ...inReplyThread.data]
    .filter((message) => message.role === 'assistant' && !message.deletedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, REPLY_PAGE_SIZE)
    .map((message) => ({
      createdAt: message.createdAt,
      messageId: message.id,
      text: message.content,
    }))
}
