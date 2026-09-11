import type { FastifyInstance } from 'fastify'

import {
  AgentConversationRecordSchema,
  AgentIdSchema,
  CHAT_MESSAGE_MAX_CHARS,
  detectSecrets,
  RenameThreadBodySchema,
  StartAgentConversationBodySchema,
  ThreadIdSchema,
} from '@nessie/schemas'
import {
  listAgentConversationsForUser,
  loadConversationForUser,
  renameThreadForUser,
  startAgentConversation,
} from '@nessie/team-admin'

import { ListAgentConversationsQuerySchema } from '../contracts/agent-conversations.js'
import { ThreadMessageRecordSchema } from '../contracts/messaging.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { createThreadMessage } from '../services/message-create.js'
import { deliverCreatedMessage } from '../services/message-delivery.js'
import { mapMessageRecord } from '../services/message-read-model.js'
import { findThreadForUser } from '../services/message-read-state.js'
import type { RouteDeps } from './types.js'

/**
 * Conversations with an agent.
 *
 * Four reads and writes over one idea: a conversation is a `Thread` whose
 * `agentId` names who it is with (docs/plans/2026-09-08-agent-conversations.md).
 * Every decision — who may see a thread, which threads are an agent's, where a
 * new one may start, what a title is — lives in `@nessie/team-admin` so the
 * assistant's tools reach the same answers; these handlers map outcomes to
 * status codes and nothing else.
 *
 * Path ids are UUID-guarded before they reach Prisma: a malformed id on a
 * `uuid` column raises inside the driver and answers 500, which both leaks the
 * shape of the query and hides a plain 404.
 */
export const registerAgentConversationRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const {
    prisma,
    realtimeHub,
    requireActorContext,
    requireUserActor,
    buildChannelRealtimeScopes,
    messageMemoryCaptureConfig,
  } = deps

  app.get('/api/agents/:agentId/conversations', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { agentId } = request.params as { agentId: string }
    if (!AgentIdSchema.safeParse(agentId).success) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const query = parseInput(ListAgentConversationsQuerySchema, request.query ?? {}, reply)
    if (!query) return reply

    const page = await listAgentConversationsForUser(prisma, {
      uoaIdentity: actorContext.actionContext.uoaIdentity,
      agentId,
      cursor: query.cursor,
      limit: query.limit,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    // Null, not an empty page: an agent this person cannot see must not be
    // confirmed to exist by the shape of the answer.
    if (!page) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(
      AgentConversationRecordSchema.array().parse(page.data),
      page.meta,
    )
  })

  app.post('/api/agents/:agentId/conversations', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { agentId } = request.params as { agentId: string }
    if (!AgentIdSchema.safeParse(agentId).success) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    // The oversized-body refusal comes before validation for the same reason it
    // does on `POST /api/threads/:threadId/messages`: the client has to be able
    // to tell "too large, offer a file upload" from generic validation.
    const rawMessage =
      typeof request.body === 'object'
      && request.body !== null
      && 'message' in request.body
      && typeof (request.body as { message: unknown }).message === 'string'
        ? (request.body as { message: string }).message
        : null
    if (rawMessage !== null && rawMessage.length > CHAT_MESSAGE_MAX_CHARS) {
      reply.status(413).send({
        error: {
          code: 'MESSAGE_TOO_LARGE',
          message:
            `Message is ${rawMessage.length} characters; the chat limit is ${CHAT_MESSAGE_MAX_CHARS}.`
            + ' Send as a file instead.',
          limit: CHAT_MESSAGE_MAX_CHARS,
          length: rawMessage.length,
        },
      })
      return reply
    }

    const body = parseInput(StartAgentConversationBodySchema, request.body ?? {}, reply)
    if (!body) return reply

    // Scanned before anything is written, so a pasted credential never creates
    // the thread either. The chat door is the authoritative boundary and this
    // is the same door under a different name.
    if (body.message && detectSecrets(body.message).length > 0) {
      sendApiError(
        reply,
        422,
        'SECRET_INTERCEPTED',
        'Nessie did not send this message because it contains a credential.'
        + ' Save it through Secrets instead.',
      )
      return reply
    }

    const started = await startAgentConversation(prisma, {
      agentId,
      channelId: body.channelId,
      message: body.message,
      organizationId: actorContext.tenant.organizationId,
      startedByUserId: actorContext.actor.actorId,
      title: body.title,
    })
    if (started.kind === 'agent_not_found') {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }
    if (started.kind === 'no_room') {
      sendApiError(
        reply,
        409,
        'AGENT_CONVERSATION_NO_ROOM',
        'This agent is not in any channel you can post in. Add it to a channel first.',
      )
      return reply
    }
    if (started.kind === 'channel_not_allowed') {
      sendApiError(
        reply,
        403,
        'AGENT_CONVERSATION_CHANNEL_NOT_ALLOWED',
        'That channel is not one you can start a conversation with this agent in.',
      )
      return reply
    }

    const message = body.message
      ? await postOpeningMessage({
        actorContext,
        body: { clientMessageId: body.clientMessageId, message: body.message },
        deps: {
          buildChannelRealtimeScopes,
          messageMemoryCaptureConfig,
          prisma,
          realtimeHub,
        },
        log: request.log,
        threadId: started.thread.id,
      })
      : null

    const conversation = await loadConversationForUser(prisma, {
      uoaIdentity: actorContext.actionContext.uoaIdentity,
      organizationId: actorContext.tenant.organizationId,
      threadId: started.thread.id,
      userId: actorContext.actor.actorId,
    })
    // Unreachable in practice — the thread was just created in a room this
    // person can see — but a null here is a bug, not a 201 with no body.
    if (!conversation) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    return reply.code(201).send(
      createApiResponse({
        conversation: AgentConversationRecordSchema.parse(conversation),
        message: message ? ThreadMessageRecordSchema.parse(message) : null,
      }),
    )
  })

  app.patch('/api/threads/:threadId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { threadId } = request.params as { threadId: string }
    if (!ThreadIdSchema.safeParse(threadId).success) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    const body = parseInput(RenameThreadBodySchema, request.body, reply)
    if (!body) return reply

    const outcome = await renameThreadForUser(prisma, {
      organizationId: actorContext.tenant.organizationId,
      threadId,
      title: body.title,
      userId: actorContext.actor.actorId,
    })
    if (outcome.kind === 'not_found') {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }
    if (outcome.kind === 'title_fixed') {
      sendApiError(
        reply,
        400,
        'THREAD_TITLE_FIXED',
        'This is the channel’s own thread and takes the channel’s name.'
        + ' Rename the channel instead.',
      )
      return reply
    }
    if (outcome.kind === 'forbidden') {
      sendApiError(
        reply,
        403,
        'FORBIDDEN',
        'Only whoever started this conversation, or someone who manages the channel, can rename it.',
      )
      return reply
    }

    const conversation = await loadConversationForUser(prisma, {
      uoaIdentity: actorContext.actionContext.uoaIdentity,
      organizationId: actorContext.tenant.organizationId,
      threadId: outcome.threadId,
      userId: actorContext.actor.actorId,
    })
    if (!conversation) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }
    return createApiResponse(AgentConversationRecordSchema.parse(conversation))
  })

  app.get('/api/threads/:threadId/conversation', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { threadId } = request.params as { threadId: string }
    if (!ThreadIdSchema.safeParse(threadId).success) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    const conversation = await loadConversationForUser(prisma, {
      uoaIdentity: actorContext.actionContext.uoaIdentity,
      organizationId: actorContext.tenant.organizationId,
      threadId,
      userId: actorContext.actor.actorId,
    })
    // The same words the other thread reads use, so an id confirms nothing —
    // including for a General thread of a room with no agent in it.
    if (!conversation) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }
    return createApiResponse(AgentConversationRecordSchema.parse(conversation))
  })
}

/**
 * The opening message, posted as the person and dispatched exactly as
 * `POST /api/threads/:threadId/messages` dispatches: `createThreadMessage`
 * writes the row with its idempotency key, mention validation, alerts and
 * participate-to-follow, and `deliverCreatedMessage` — the shared service that
 * route already calls — announces it, pushes it, remembers it and wakes the
 * agent. There is deliberately no second copy of that sequence here.
 */
const postOpeningMessage = async (input: {
  actorContext: Parameters<typeof deliverCreatedMessage>[1]['actorContext']
  body: { clientMessageId?: string | undefined; message: string }
  deps: Parameters<typeof deliverCreatedMessage>[0]
  log: Parameters<typeof deliverCreatedMessage>[1]['log']
  threadId: string
}): Promise<ReturnType<typeof mapMessageRecord> | null> => {
  const { actorContext, body, deps, threadId } = input
  const thread = await findThreadForUser(
    deps.prisma,
    threadId,
    actorContext.actor.actorId,
    actorContext.tenant.organizationId,
  )
  if (!thread) return null

  const result = await createThreadMessage(deps.prisma, {
    content: body.message,
    threadId: thread.id,
    userId: actorContext.actor.actorId,
    ...(body.clientMessageId ? { clientMessageId: body.clientMessageId } : {}),
  })
  if (result.kind === 'replayed') return mapMessageRecord(result.message, 0)
  if (result.kind !== 'created') return null

  await deliverCreatedMessage(deps, {
    actorContext,
    content: body.message,
    log: input.log,
    result,
    thread,
  })
  return mapMessageRecord(result.message, 0)
}
