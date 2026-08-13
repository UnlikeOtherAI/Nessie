import type { FastifyInstance } from 'fastify'

import {
  DocumentStreamDetailResponseSchema,
  DocumentStreamListResponseSchema,
  DocumentStreamRetargetBodySchema,
  DocumentStreamRetargetResponseSchema,
} from '@nessie/schemas'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  getThreadDocumentStream,
  listThreadDocumentStreams,
  retargetDocumentStream,
} from '../services/document-streams.js'
import { findThreadForUser } from '../services/messages.js'
import { createKnowledgeAccess } from './knowledge-base-access.js'
import type { RouteDeps } from './types.js'

// Live document composition: bootstrap reads for the popup plus the address
// bar's retarget. All three gate on thread visibility exactly like the thinking
// routes and the SSE stream; the service additionally binds every session to the
// thread and organization it was asked for.
export const registerThreadDocumentStreamRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { prisma, realtimeHub, requireActorContext } = deps
  const knowledge = createKnowledgeAccess(deps)

  app.get('/api/threads/:threadId/document-streams', async (request, reply) => {
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

    const { active } = request.query as { active?: string }
    const sessions = await listThreadDocumentStreams(prisma, {
      activeOnly: active === '1' || active === 'true',
      organizationId: actorContext.tenant.organizationId,
      threadId: thread.id,
    })

    return createApiResponse(DocumentStreamListResponseSchema.parse({ sessions }))
  })

  app.get('/api/threads/:threadId/document-streams/:sessionId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { threadId, sessionId } = request.params as { threadId: string; sessionId: string }
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

    const detail = await getThreadDocumentStream(prisma, {
      organizationId: actorContext.tenant.organizationId,
      sessionId,
      threadId: thread.id,
    })
    if (!detail) {
      sendApiError(reply, 404, 'DOCUMENT_STREAM_NOT_FOUND', 'Document stream not found')
      return reply
    }

    return createApiResponse(DocumentStreamDetailResponseSchema.parse(detail))
  })

  app.post('/api/threads/:threadId/document-streams/:sessionId/target', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { threadId, sessionId } = request.params as { threadId: string; sessionId: string }
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

    const body = parseInput(DocumentStreamRetargetBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const outcome = await retargetDocumentStream(
      prisma,
      {
        actorContext,
        knowledge,
        publishSse: (targetThreadId, event, data) =>
          realtimeHub.publishSse(targetThreadId, event, data),
      },
      {
        organizationId: actorContext.tenant.organizationId,
        parentPageId: body.parentPageId ?? null,
        sessionId,
        spaceId: body.spaceId,
        threadId: thread.id,
      },
    )

    switch (outcome.kind) {
      case 'ok':
        return createApiResponse(DocumentStreamRetargetResponseSchema.parse({
          moved: outcome.moved,
          session: outcome.session,
        }))
      case 'not_found':
        sendApiError(reply, 404, 'DOCUMENT_STREAM_NOT_FOUND', 'Document stream not found')
        return reply
      case 'space_not_found':
        sendApiError(reply, 404, 'KNOWLEDGE_SPACE_NOT_FOUND', 'Space not found')
        return reply
      case 'parent_not_found':
        sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Parent page not found')
        return reply
      case 'space_forbidden':
        sendApiError(
          reply,
          403,
          'POLICY_DENIED',
          'Knowledge base access denied: WRITE_NOT_PERMITTED',
        )
        return reply
      case 'page_missing':
        sendApiError(
          reply,
          409,
          'DOCUMENT_STREAM_PAGE_MISSING',
          'The saved document could not be found',
        )
        return reply
      case 'cross_space_move':
        sendApiError(
          reply,
          409,
          'DOCUMENT_STREAM_SPACE_MOVE_UNSUPPORTED',
          'A saved document can be re-parented but not moved to another space',
        )
        return reply
      default:
        sendApiError(
          reply,
          409,
          'DOCUMENT_STREAM_NOT_RETARGETABLE',
          `A ${outcome.status} document stream cannot be retargeted`,
        )
        return reply
    }
  })
}
