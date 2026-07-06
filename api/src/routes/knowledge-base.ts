import type { FastifyInstance } from 'fastify'
import { buildNativeSourceRef, type KnowledgePageRecord } from '@nessie/knowledge'
import { attributionFromActorContext } from '@nessie/runtime'
import {
  CreateKnowledgePageBodySchema,
  CreateKnowledgeSpaceBodySchema,
  KnowledgeListQuerySchema,
  MoveKnowledgePageBodySchema,
  RestoreKnowledgePageVersionBodySchema,
  SearchKnowledgePagesBodySchema,
  UpdateKnowledgePageBodySchema,
  UpdateKnowledgeSpaceBodySchema,
} from '../contracts/knowledge-base.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { getQueryEmbedding } from '../services/knowledge-query-embedding.js'
import {
  actorAuthorType,
  attachPageEnvelope,
  attachSpaceEnvelope,
  createKnowledgeAccess,
  policyTrace,
  requireKnowledgePolicy,
  requireProjectId,
  requestIds,
  type KnowledgeRouteDeps,
} from './knowledge-base-access.js'
import { sendKnowledgeMutationError } from './knowledge-base-errors.js'

export const registerKnowledgeBaseRoutes = (
  app: FastifyInstance,
  deps: KnowledgeRouteDeps,
): void => {
  const { prisma, requireActorContext } = deps
  const { provider, buildViewer, accessSpace, accessPageSpace } = createKnowledgeAccess(deps)

  app.get('/api/knowledge-base/spaces', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const query = parseInput(KnowledgeListQuerySchema, request.query, reply, 'query')
    if (!query) return reply
    const decision = await requireKnowledgePolicy(
      deps,
      actorContext,
      reply,
      'knowledge_space',
      'view',
    )
    if (!decision) return reply
    const viewer = await buildViewer(actorContext)
    const result = await provider.listSpaces({
      organizationId: actorContext.tenant.organizationId,
      projectId: query.projectId ?? actorContext.tenant.projectId ?? undefined,
      cursor: query.cursor,
      limit: query.limit,
      viewer,
    })
    return createApiResponse(
      result.data.map((space) => attachSpaceEnvelope(space, decision, viewer)),
      result.meta,
    )
  })

  app.post('/api/knowledge-base/spaces', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(CreateKnowledgeSpaceBodySchema, request.body, reply)
    if (!body) return reply
    const projectId = requireProjectId(actorContext, body.projectId, reply)
    if (!projectId) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_space', 'create')
    if (!decision) return reply
    const viewer = await buildViewer(actorContext)
    // The org-wide knowledge_space:create grant is evaluated against the caller's
    // own session project, so without this check a user could pass any sibling
    // project's id in the body and plant a writable space there. Human actors may
    // only create in a project they belong to; agents/services keep bypass.
    if (!viewer.bypass && !viewer.projectIds.has(projectId)) {
      sendApiError(
        reply,
        403,
        'POLICY_DENIED',
        'Cannot create a knowledge space in a project you do not belong to',
      )
      return reply
    }
    const space = await provider.createSpace({
      ...body,
      organizationId: actorContext.tenant.organizationId,
      projectId,
      createdBy: actorContext.actor.actorId,
    })
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'kb.space.created',
      resourceType: 'knowledge_space',
      resourceId: space.id,
      outcome: 'success',
      metadata: { name: space.name },
      ...requestIds(request),
    })
    return reply.code(201).send(createApiResponse(attachSpaceEnvelope(space, decision, viewer)))
  })

  app.get('/api/knowledge-base/spaces/:spaceId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_space', 'view')
    if (!decision) return reply
    const { spaceId } = request.params as { spaceId: string }
    const viewer = await buildViewer(actorContext)
    const space = await accessSpace(actorContext, spaceId, viewer, 'read', reply)
    if (!space) return reply
    return createApiResponse(attachSpaceEnvelope(space, decision, viewer))
  })

  app.patch('/api/knowledge-base/spaces/:spaceId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(UpdateKnowledgeSpaceBodySchema, request.body, reply)
    if (!body) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_space', 'edit')
    if (!decision) return reply
    const { spaceId } = request.params as { spaceId: string }
    const viewer = await buildViewer(actorContext)
    if (!(await accessSpace(actorContext, spaceId, viewer, 'write', reply))) return reply
    const space = await provider.updateSpace(actorContext.tenant.organizationId, spaceId, body)
    if (!space) return sendApiError(reply, 404, 'KNOWLEDGE_SPACE_NOT_FOUND', 'Space not found')
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'kb.space.updated',
      resourceType: 'knowledge_space',
      resourceId: space.id,
      outcome: 'success',
      ...requestIds(request),
    })
    return createApiResponse(attachSpaceEnvelope(space, decision, viewer))
  })

  app.delete('/api/knowledge-base/spaces/:spaceId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_space', 'edit')
    if (!decision) return reply
    const { spaceId } = request.params as { spaceId: string }
    const viewer = await buildViewer(actorContext)
    if (!(await accessSpace(actorContext, spaceId, viewer, 'write', reply))) return reply
    const space = await provider.archiveSpace(actorContext.tenant.organizationId, spaceId)
    if (!space) return sendApiError(reply, 404, 'KNOWLEDGE_SPACE_NOT_FOUND', 'Space not found')
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'kb.space.archived',
      resourceType: 'knowledge_space',
      resourceId: space.id,
      outcome: 'success',
      ...requestIds(request),
    })
    return createApiResponse(attachSpaceEnvelope(space, decision, viewer))
  })

  app.get('/api/knowledge-base/spaces/:spaceId/pages', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const query = parseInput(KnowledgeListQuerySchema, request.query, reply, 'query')
    if (!query) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'view')
    if (!decision) return reply
    const { spaceId } = request.params as { spaceId: string }
    const viewer = await buildViewer(actorContext)
    if (!(await accessSpace(actorContext, spaceId, viewer, 'read', reply))) return reply
    const pages = await provider.listPages({
      organizationId: actorContext.tenant.organizationId,
      spaceId,
      includeArchived: query.includeArchived === 'true',
    })
    return createApiResponse(pages.map((page) => attachPageEnvelope(page, decision)))
  })

  app.post('/api/knowledge-base/spaces/:spaceId/pages', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(CreateKnowledgePageBodySchema, request.body, reply)
    if (!body) return reply
    const projectId = requireProjectId(actorContext, body.projectId, reply)
    if (!projectId) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'create')
    if (!decision) return reply
    const { spaceId } = request.params as { spaceId: string }
    const viewer = await buildViewer(actorContext)
    if (!(await accessSpace(actorContext, spaceId, viewer, 'write', reply))) return reply
    let page: KnowledgePageRecord
    try {
      page = await provider.createPage({
        ...body,
        organizationId: actorContext.tenant.organizationId,
        projectId,
        spaceId,
        authorId: actorContext.actor.actorId,
        authorType: actorAuthorType(actorContext),
        createdBy: actorContext.actor.actorId,
      })
    } catch (error) {
      return sendKnowledgeMutationError(request, reply, error, {
        code: 'KNOWLEDGE_PAGE_INVALID',
        message: 'Knowledge page could not be created',
        statusCode: 400,
      })
    }
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'kb.page.created',
      resourceType: 'knowledge_page',
      resourceId: page.id,
      outcome: 'success',
      metadata: { spaceId, title: page.title },
      ...requestIds(request),
    })
    return reply.code(201).send(createApiResponse(attachPageEnvelope(page, decision)))
  })

  app.post('/api/knowledge-base/search', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(SearchKnowledgePagesBodySchema, request.body, reply)
    if (!body) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'search')
    if (!decision) return reply
    const viewer = await buildViewer(actorContext)
    const organizationId = actorContext.tenant.organizationId
    const projectId = body.projectId ?? actorContext.tenant.projectId ?? undefined
    const query = body.query?.trim()
    // Hybrid needs query text and provider support; force keyword mode
    // otherwise. Both paths pass `viewer` through so the provider applies the
    // space-read SQL pre-filter itself (readableSpaceIdsSql) instead of the
    // per-space post-filter this route used to run after the fact — bypass
    // viewers were never filtered anyway.
    const hybridSearch = provider.searchPagesHybrid
    const mode = body.mode ?? (query ? 'hybrid' : 'keyword')

    if (mode === 'hybrid' && query && hybridSearch) {
      const queryEmbedding = await getQueryEmbedding(
        deps.sharedModelClient,
        query,
        attributionFromActorContext(actorContext),
      )
      const result = await hybridSearch({
        organizationId,
        query,
        queryEmbedding,
        viewer,
        projectId,
        spaceId: body.spaceId,
        limit: body.limit,
      })
      return createApiResponse(
        result.data.map((hit) => ({
          page: attachPageEnvelope(hit.page, decision),
          snippet: hit.snippet,
          passages: hit.passages,
          score: hit.score,
        })),
        result.meta,
      )
    }

    const result = await provider.searchPages({
      ...body,
      organizationId,
      projectId,
      viewer,
    })
    return createApiResponse(
      result.data.map((hit) => ({
        page: attachPageEnvelope(hit.page, decision),
        snippet: hit.snippet,
      })),
      result.meta,
    )
  })

  app.get('/api/knowledge-base/pages/:pageId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'read')
    if (!decision) return reply
    const { pageId } = request.params as { pageId: string }
    const page = await provider.getPage(actorContext.tenant.organizationId, pageId)
    if (!page) return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
    const viewer = await buildViewer(actorContext)
    if (!(await accessPageSpace(actorContext, page, viewer, 'read', reply))) return reply
    return createApiResponse(attachPageEnvelope(page, decision))
  })

  app.patch('/api/knowledge-base/pages/:pageId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(UpdateKnowledgePageBodySchema, request.body, reply)
    if (!body) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'edit')
    if (!decision) return reply
    const { pageId } = request.params as { pageId: string }
    const existingPage = await provider.getPage(actorContext.tenant.organizationId, pageId)
    if (!existingPage) return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
    const viewer = await buildViewer(actorContext)
    if (!(await accessPageSpace(actorContext, existingPage, viewer, 'write', reply))) return reply
    let page: KnowledgePageRecord | null
    try {
      page = await provider.updatePage(pageId, {
        ...body,
        organizationId: actorContext.tenant.organizationId,
        authorId: actorContext.actor.actorId,
        authorType: actorAuthorType(actorContext),
      })
    } catch (error) {
      return sendKnowledgeMutationError(request, reply, error, {
        code: 'KNOWLEDGE_PAGE_INVALID',
        message: 'Knowledge page could not be updated',
        statusCode: 400,
      })
    }
    if (!page) return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'kb.page.updated',
      resourceType: 'knowledge_page',
      resourceId: page.id,
      outcome: 'success',
      metadata: { latestVersionId: page.latestVersion?.id ?? null },
      ...requestIds(request),
    })
    return createApiResponse(attachPageEnvelope(page, decision))
  })

  app.delete('/api/knowledge-base/pages/:pageId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'edit')
    if (!decision) return reply
    const { pageId } = request.params as { pageId: string }
    const existingPage = await provider.getPage(actorContext.tenant.organizationId, pageId)
    if (!existingPage) return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
    const viewer = await buildViewer(actorContext)
    if (!(await accessPageSpace(actorContext, existingPage, viewer, 'write', reply))) return reply
    // Free the page's stored files (file-node versions + drawer attachments) and
    // decrement storage usage before archiving, so deletion always updates usage.
    await deps.fileService.purgeKnowledgePageFiles(
      pageId,
      actorContext.tenant.organizationId,
      attributionFromActorContext(actorContext),
    )
    const page = await provider.archivePage(actorContext.tenant.organizationId, pageId)
    if (!page) return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'kb.page.archived',
      resourceType: 'knowledge_page',
      resourceId: page.id,
      outcome: 'success',
      ...requestIds(request),
    })
    return createApiResponse(attachPageEnvelope(page, decision))
  })

  app.post('/api/knowledge-base/pages/:pageId/publish', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'approve')
    if (!decision) return reply
    const { pageId } = request.params as { pageId: string }
    const existingPage = await provider.getPage(actorContext.tenant.organizationId, pageId)
    if (!existingPage) return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
    const viewer = await buildViewer(actorContext)
    if (!(await accessPageSpace(actorContext, existingPage, viewer, 'write', reply))) return reply
    let page: KnowledgePageRecord | null
    try {
      page = await provider.publishPage({
        organizationId: actorContext.tenant.organizationId,
        pageId,
      })
    } catch (error) {
      return sendKnowledgeMutationError(request, reply, error, {
        code: 'KNOWLEDGE_PAGE_INVALID',
        message: 'Knowledge page could not be published',
        statusCode: 400,
      })
    }
    if (!page) return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'kb.page.published',
      resourceType: 'knowledge_page',
      resourceId: page.id,
      outcome: 'success',
      metadata: { publishedVersionId: page.publishedVersionId },
      ...requestIds(request),
    })
    return createApiResponse(attachPageEnvelope(page, decision))
  })

  app.post('/api/knowledge-base/pages/:pageId/move', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(MoveKnowledgePageBodySchema, request.body, reply)
    if (!body) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'edit')
    if (!decision) return reply
    const { pageId } = request.params as { pageId: string }
    const existingPage = await provider.getPage(actorContext.tenant.organizationId, pageId)
    if (!existingPage) return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
    const viewer = await buildViewer(actorContext)
    if (!(await accessPageSpace(actorContext, existingPage, viewer, 'write', reply))) return reply
    let page: KnowledgePageRecord | null
    try {
      page = await provider.movePage({
        organizationId: actorContext.tenant.organizationId,
        pageId,
        parentPageId: body.parentPageId,
        position: body.position,
      })
    } catch (error) {
      return sendKnowledgeMutationError(request, reply, error, {
        code: 'KNOWLEDGE_PAGE_MOVE_INVALID',
        message: 'Knowledge page could not be moved',
        statusCode: 400,
      })
    }
    if (!page) return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'kb.page.moved',
      resourceType: 'knowledge_page',
      resourceId: page.id,
      outcome: 'success',
      metadata: { parentPageId: page.parentPageId, position: page.position },
      ...requestIds(request),
    })
    return createApiResponse(attachPageEnvelope(page, decision))
  })

  app.get('/api/knowledge-base/pages/:pageId/versions', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'read')
    if (!decision) return reply
    const { pageId } = request.params as { pageId: string }
    const versionsPage = await provider.getPage(actorContext.tenant.organizationId, pageId)
    if (!versionsPage) return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
    const viewer = await buildViewer(actorContext)
    if (!(await accessPageSpace(actorContext, versionsPage, viewer, 'read', reply))) return reply
    const versions = await provider.listVersions(actorContext.tenant.organizationId, pageId)
    return createApiResponse(versions.map((version) => ({
      ...version,
      policyChainTrace: policyTrace(decision),
      sourceRef: buildNativeSourceRef(pageId, version.id),
      visibilityReason: `version history visible, ${decision.reasonCode}`,
    })))
  })

  app.post('/api/knowledge-base/pages/:pageId/versions/:versionId/restore', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(RestoreKnowledgePageVersionBodySchema, request.body, reply)
    if (!body) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'edit')
    if (!decision) return reply
    const { pageId, versionId } = request.params as { pageId: string; versionId: string }
    const existingPage = await provider.getPage(actorContext.tenant.organizationId, pageId)
    if (!existingPage) return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
    const viewer = await buildViewer(actorContext)
    if (!(await accessPageSpace(actorContext, existingPage, viewer, 'write', reply))) return reply
    let page: KnowledgePageRecord | null
    try {
      page = await provider.restoreVersion({
        organizationId: actorContext.tenant.organizationId,
        pageId,
        versionId,
        authorId: actorContext.actor.actorId,
        authorType: actorAuthorType(actorContext),
        changeComment: body.changeComment,
      })
    } catch (error) {
      return sendKnowledgeMutationError(request, reply, error, {
        code: 'KNOWLEDGE_VERSION_INVALID',
        message: 'Knowledge version could not be restored',
        statusCode: 400,
      })
    }
    if (!page) return sendApiError(reply, 404, 'KNOWLEDGE_VERSION_NOT_FOUND', 'Version not found')
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'kb.page.restored',
      resourceType: 'knowledge_page',
      resourceId: page.id,
      outcome: 'success',
      metadata: { restoredVersionId: versionId, latestVersionId: page.latestVersion?.id ?? null },
      ...requestIds(request),
    })
    return createApiResponse(attachPageEnvelope(page, decision))
  })
}
