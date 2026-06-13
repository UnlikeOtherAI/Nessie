import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  createAnnotationService,
  findAnnotationLocation,
  isKnowledgeAnnotationError,
  type AnnotationAccess,
  type AnnotationActor,
  type SpaceViewer,
} from '@nessie/knowledge'
import type { AuditAction, AuthorizedActionContext } from '@nessie/schemas'
import {
  AnnotationListQuerySchema,
  CreateCommentBodySchema,
  CreateNoteBodySchema,
  CreateReplyBodySchema,
  EditAnnotationBodySchema,
  ToggleReactionBodySchema,
} from '../contracts/knowledge-comments.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import {
  actorAuthorType,
  createKnowledgeAccess,
  requireKnowledgePolicy,
  requestIds,
  type KnowledgeRouteDeps,
} from './knowledge-base-access.js'

const buildActor = (actorContext: AuthorizedActionContext): AnnotationActor => ({
  authorType: actorAuthorType(actorContext),
  authorId: actorContext.actor.actorId,
})

const sendAnnotationError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (isKnowledgeAnnotationError(error)) {
    if (error.code === 'not_found') {
      return sendApiError(reply, 404, 'ANNOTATION_NOT_FOUND', error.message)
    }
    if (error.code === 'forbidden') {
      return sendApiError(reply, 403, 'POLICY_DENIED', error.message)
    }
    return sendApiError(reply, 400, 'ANNOTATION_INVALID', error.message)
  }
  throw error
}

export const registerKnowledgeCommentRoutes = (
  app: FastifyInstance,
  deps: KnowledgeRouteDeps,
): void => {
  const { prisma, requireActorContext } = deps
  const { provider, buildViewer, accessSpace } = createKnowledgeAccess(deps)
  const service = createAnnotationService({ prisma })

  // Load a page and enforce space access, returning the AnnotationAccess the
  // service needs. Sends 404/403 and returns null when the caller may not proceed.
  const buildPageAccess = async (
    actorContext: AuthorizedActionContext,
    pageId: string,
    viewer: SpaceViewer,
    mode: 'read' | 'write',
    reply: FastifyReply,
  ): Promise<AnnotationAccess | null> => {
    const organizationId = actorContext.tenant.organizationId
    const page = await provider.getPage(organizationId, pageId)
    if (!page) {
      sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
      return null
    }
    const space = await accessSpace(actorContext, page.spaceId, viewer, mode, reply)
    if (!space) return null
    return { space, viewer, organizationId, pageId: page.id, spaceId: page.spaceId }
  }

  const accessForAnnotation = async (
    actorContext: AuthorizedActionContext,
    annotationId: string,
    viewer: SpaceViewer,
    mode: 'read' | 'write',
    reply: FastifyReply,
  ): Promise<AnnotationAccess | null> => {
    const location = await findAnnotationLocation(
      prisma,
      actorContext.tenant.organizationId,
      annotationId,
    )
    if (!location) {
      sendApiError(reply, 404, 'ANNOTATION_NOT_FOUND', 'Annotation not found')
      return null
    }
    return buildPageAccess(actorContext, location.pageId, viewer, mode, reply)
  }

  const auditAnnotation = (
    actorContext: AuthorizedActionContext,
    request: FastifyRequest,
    action: AuditAction,
    annotation: { id: string; pageId: string; kind: string },
  ) =>
    emitAuditEvent(prisma, {
      actorContext,
      action,
      resourceType: 'knowledge_page',
      resourceId: annotation.pageId,
      outcome: 'success',
      metadata: { annotationId: annotation.id, kind: annotation.kind },
      ...requestIds(request),
    })

  app.get('/api/knowledge-base/pages/:pageId/annotations', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const query = parseInput(AnnotationListQuerySchema, request.query, reply, 'query')
    if (!query) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'read')
    if (!decision) return reply
    const { pageId } = request.params as { pageId: string }
    const viewer = await buildViewer(actorContext)
    const access = await buildPageAccess(actorContext, pageId, viewer, 'read', reply)
    if (!access) return reply
    const items = await service.listForPage(access, query.kind ? { kind: query.kind } : undefined)
    return createApiResponse(items)
  })

  app.post('/api/knowledge-base/pages/:pageId/comments', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(CreateCommentBodySchema, request.body, reply)
    if (!body) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'create')
    if (!decision) return reply
    const { pageId } = request.params as { pageId: string }
    const viewer = await buildViewer(actorContext)
    const access = await buildPageAccess(actorContext, pageId, viewer, 'read', reply)
    if (!access) return reply
    try {
      const comment = await service.createComment(access, { body: body.body, actor: buildActor(actorContext) })
      await auditAnnotation(actorContext, request, 'kb.annotation.created', comment)
      return reply.code(201).send(createApiResponse(comment))
    } catch (error) {
      return sendAnnotationError(reply, error)
    }
  })

  app.post('/api/knowledge-base/pages/:pageId/notes', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(CreateNoteBodySchema, request.body, reply)
    if (!body) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'create')
    if (!decision) return reply
    const { pageId } = request.params as { pageId: string }
    const viewer = await buildViewer(actorContext)
    const access = await buildPageAccess(actorContext, pageId, viewer, 'read', reply)
    if (!access) return reply
    try {
      const note = await service.createNote(access, {
        body: body.body,
        anchor: body.anchor,
        anchorVersionId: body.anchorVersionId ?? null,
        actor: buildActor(actorContext),
      })
      await auditAnnotation(actorContext, request, 'kb.annotation.created', note)
      return reply.code(201).send(createApiResponse(note))
    } catch (error) {
      return sendAnnotationError(reply, error)
    }
  })

  app.post('/api/knowledge-base/annotations/:annotationId/replies', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(CreateReplyBodySchema, request.body, reply)
    if (!body) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'create')
    if (!decision) return reply
    const { annotationId } = request.params as { annotationId: string }
    const viewer = await buildViewer(actorContext)
    const access = await accessForAnnotation(actorContext, annotationId, viewer, 'read', reply)
    if (!access) return reply
    try {
      const replyRecord = await service.reply(access, {
        parentId: annotationId,
        body: body.body,
        actor: buildActor(actorContext),
      })
      await auditAnnotation(actorContext, request, 'kb.annotation.replied', replyRecord)
      return reply.code(201).send(createApiResponse(replyRecord))
    } catch (error) {
      return sendAnnotationError(reply, error)
    }
  })

  app.post('/api/knowledge-base/annotations/:annotationId/reactions', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(ToggleReactionBodySchema, request.body, reply)
    if (!body) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'create')
    if (!decision) return reply
    const { annotationId } = request.params as { annotationId: string }
    const viewer = await buildViewer(actorContext)
    const access = await accessForAnnotation(actorContext, annotationId, viewer, 'read', reply)
    if (!access) return reply
    try {
      const updated = await service.toggleReaction(access, {
        annotationId,
        emoji: body.emoji,
        actor: buildActor(actorContext),
      })
      return createApiResponse(updated)
    } catch (error) {
      return sendAnnotationError(reply, error)
    }
  })

  const setState = async (
    request: FastifyRequest,
    reply: FastifyReply,
    state: 'open' | 'resolved',
  ) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    // Resolve/reopen is a write to shared state: gated by the 'edit' capability
    // plus per-space write access (canWriteSpace) below.
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'edit')
    if (!decision) return reply
    const { annotationId } = request.params as { annotationId: string }
    const viewer = await buildViewer(actorContext)
    const access = await accessForAnnotation(actorContext, annotationId, viewer, 'write', reply)
    if (!access) return reply
    try {
      const updated = await service.setState(access, {
        annotationId,
        state,
        actor: buildActor(actorContext),
      })
      await auditAnnotation(
        actorContext,
        request,
        state === 'resolved' ? 'kb.annotation.resolved' : 'kb.annotation.reopened',
        updated,
      )
      return createApiResponse(updated)
    } catch (error) {
      return sendAnnotationError(reply, error)
    }
  }

  app.post('/api/knowledge-base/annotations/:annotationId/resolve', (request, reply) =>
    setState(request, reply, 'resolved'),
  )
  app.post('/api/knowledge-base/annotations/:annotationId/reopen', (request, reply) =>
    setState(request, reply, 'open'),
  )

  app.patch('/api/knowledge-base/annotations/:annotationId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(EditAnnotationBodySchema, request.body, reply)
    if (!body) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'edit')
    if (!decision) return reply
    const { annotationId } = request.params as { annotationId: string }
    const viewer = await buildViewer(actorContext)
    const access = await accessForAnnotation(actorContext, annotationId, viewer, 'read', reply)
    if (!access) return reply
    try {
      const updated = await service.edit(access, {
        annotationId,
        body: body.body,
        actor: buildActor(actorContext),
      })
      await auditAnnotation(actorContext, request, 'kb.annotation.updated', updated)
      return createApiResponse(updated)
    } catch (error) {
      return sendAnnotationError(reply, error)
    }
  })

  app.delete('/api/knowledge-base/annotations/:annotationId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'edit')
    if (!decision) return reply
    const { annotationId } = request.params as { annotationId: string }
    const viewer = await buildViewer(actorContext)
    const access = await accessForAnnotation(actorContext, annotationId, viewer, 'read', reply)
    if (!access) return reply
    try {
      await service.remove(access, { annotationId, actor: buildActor(actorContext) })
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'kb.annotation.deleted',
        resourceType: 'knowledge_page',
        resourceId: access.pageId,
        outcome: 'success',
        metadata: { annotationId },
        ...requestIds(request),
      })
      return createApiResponse({ id: annotationId, deleted: true })
    } catch (error) {
      return sendAnnotationError(reply, error)
    }
  })
}
