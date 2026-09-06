import type { FastifyInstance } from 'fastify'

import { followReplyThread, unfollowReplyThread } from '@nessie/runtime'
import { SetMessageThreadFollowBodySchema, ThreadMessageRecordSchema } from '../contracts/messaging.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  mapMessageRecordWithAttachments,
  messageInclude,
} from '../services/message-read-model.js'
import { findThreadForUser } from '../services/message-read-state.js'
import type { RouteDeps } from './types.js'

// Message-level reply threads (#233): single-message read (with the viewer's
// follow state) and explicit follow/unfollow of a reply thread.
export const registerThreadReplyRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext } = deps

  app.get('/api/threads/:threadId/messages/:messageId', async (request, reply) => {
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

    const message = await prisma.message.findFirst({
      where: { id: messageId, threadId: thread.id },
      include: messageInclude,
    })
    if (!message) {
      sendApiError(reply, 404, 'MESSAGE_NOT_FOUND', 'Message not found')
      return reply
    }

    // Follows are keyed by the reply-thread root, so for a reply the viewer's
    // follow state lives under its root message.
    const followRootId = message.rootMessageId ?? message.id
    const follow = await prisma.messageThreadFollow.findUnique({
      where: {
        rootMessageId_userId: {
          rootMessageId: followRootId,
          userId: actorContext.actor.actorId,
        },
      },
      select: { rootMessageId: true },
    })

    return createApiResponse({
      message: ThreadMessageRecordSchema.parse(
        await mapMessageRecordWithAttachments(prisma, message, {
          channelId: thread.channel.id,
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
        }),
      ),
      viewerFollowing: follow !== null,
    })
  })

  app.put('/api/threads/:threadId/messages/:messageId/follow', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(SetMessageThreadFollowBodySchema, request.body, reply)
    if (!body) {
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

    // Only root messages own a followable reply thread.
    const message = await prisma.message.findFirst({
      where: { id: messageId, threadId: thread.id, rootMessageId: null },
      select: { id: true },
    })
    if (!message) {
      sendApiError(reply, 404, 'MESSAGE_NOT_FOUND', 'Message not found')
      return reply
    }

    if (body.following) {
      await followReplyThread(prisma, {
        rootMessageId: message.id,
        userIds: [actorContext.actor.actorId],
      })
    } else {
      await unfollowReplyThread(prisma, {
        rootMessageId: message.id,
        userId: actorContext.actor.actorId,
      })
    }

    return createApiResponse({ following: body.following })
  })
}
