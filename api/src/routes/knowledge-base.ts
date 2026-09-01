import type { FastifyInstance } from 'fastify'
import {
  buildNativeSourceRef,
  type KnowledgePageRecord,
  type KnowledgeSpaceRecord,
} from '@nessie/knowledge'
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
  canManageKnowledgeSpaceAccess,
  createKnowledgeAccess,
  policyTrace,
  requireKnowledgePolicy,
  requireProjectId,
  requestIds,
  toKnowledgePaginationMeta,
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
    // Org-wide by default, narrowed only when the caller explicitly asks for a
    // project. The session's `proj` claim is just the caller's oldest project
    // membership (session-issuers.ts) — falling back to it here silently hid
    // spaces the caller is fully entitled to read: org-visibility spaces filed
    // in a sibling project, their own personal "My Docs" when it was
    // provisioned under a different project, and any project's "Project
    // Documents" they belong to. Worse, the admin reads an empty list as "first
    // visit" and seeds a fresh "General" space, so the narrowing manufactured
    // duplicate spaces. What the caller may see is `canReadSpace`'s decision,
    // applied inside listSpaces — never the session's incidental project.
    const result = await provider.listSpaces({
      organizationId: actorContext.tenant.organizationId,
      projectId: query.projectId,
      cursor: query.cursor,
      limit: query.limit,
      viewer,
    })
    // `total` is intentionally omitted: unlike a SQL-filtered list, a
    // non-bypass viewer's visibility here is applied in application code
    // *after* the page is fetched (`canReadSpace` filtering above the
    // provider's `where`), so a separate count against the same `where` would
    // describe a larger set than what this page actually shows.
    return createApiResponse(
      result.data.map((space) => attachSpaceEnvelope(space, decision, viewer, actorContext)),
      toKnowledgePaginationMeta(result.meta, Boolean(query.cursor), result.data.at(0)),
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
    // own session project, so without this check a user (or agent) could pass any
    // sibling project's id in the body and plant a writable space there. Human
    // actors may only create in a project they belong to; agents may only create
    // in a project reached via one of their channel bindings; services keep bypass.
    const inProjectReach = viewer.bypass
      || (viewer.agent ? viewer.agent.projectIds.has(projectId) : viewer.projectIds.has(projectId))
    if (!inProjectReach) {
      sendApiError(
        reply,
        403,
        'POLICY_DENIED',
        'Cannot create a knowledge space in a project you do not belong to',
      )
      return reply
    }
    let space: KnowledgeSpaceRecord
    try {
      space = await provider.createSpace({
        ...body,
        organizationId: actorContext.tenant.organizationId,
        projectId,
        createdBy: actorContext.actor.actorId,
      })
    } catch (error) {
      return sendKnowledgeMutationError(request, reply, error, {
        code: 'KNOWLEDGE_SPACE_INVALID',
        message: 'Knowledge space could not be created',
        statusCode: 400,
      })
    }
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'kb.space.created',
      resourceType: 'knowledge_space',
      resourceId: space.id,
      outcome: 'success',
      metadata: { name: space.name },
      ...requestIds(request),
    })
    return reply.code(201).send(
      createApiResponse(attachSpaceEnvelope(space, decision, viewer, actorContext)),
    )
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
    return createApiResponse(attachSpaceEnvelope(space, decision, viewer, actorContext))
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
    const changesAccess = body.writeRestricted !== undefined
      || body.memberUserIds !== undefined
      || body.memberAgentIds !== undefined
    // Access administrators must be able to reverse writeRestricted even when
    // it has removed their ordinary content-write permission. Read remains the
    // floor: no administrator may configure a space they cannot discover.
    const currentSpace = await accessSpace(
      actorContext,
      spaceId,
      viewer,
      changesAccess ? 'read' : 'write',
      reply,
    )
    if (!currentSpace) return reply
    if (changesAccess && !canManageKnowledgeSpaceAccess(currentSpace, actorContext)) {
      sendApiError(
        reply,
        403,
        'POLICY_DENIED',
        'Knowledge base access denied: SPACE_ADMIN_REQUIRED',
      )
      return reply
    }
    let space: KnowledgeSpaceRecord | null
    try {
      space = await provider.updateSpace(actorContext.tenant.organizationId, spaceId, body)
    } catch (error) {
      return sendKnowledgeMutationError(request, reply, error, {
        code: 'KNOWLEDGE_SPACE_INVALID',
        message: 'Knowledge space could not be updated',
        statusCode: 400,
      })
    }
    if (!space) return sendApiError(reply, 404, 'KNOWLEDGE_SPACE_NOT_FOUND', 'Space not found')
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'kb.space.updated',
      resourceType: 'knowledge_space',
      resourceId: space.id,
      outcome: 'success',
      ...requestIds(request),
    })
    return createApiResponse(attachSpaceEnvelope(space, decision, viewer, actorContext))
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
    return createApiResponse(attachSpaceEnvelope(space, decision, viewer, actorContext))
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
    // Explicit-only, for the same reason the space list is org-wide: the
    // viewer's own read rules already gate every hit (readableSpaceIdsSql), so
    // defaulting to the session's project only hid pages the caller may read.
    const projectId = body.projectId
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
      // `total` omitted: this is ranked semantic/lexical search (RRF-fused,
      // score-ordered), never a fixed cursor-paged set — a count answers a
      // different question than "how many hits" and the provider's hybrid
      // path (native-search-hybrid.ts) never supports a cursor at all.
      return createApiResponse(
        result.data.map((hit) => ({
          page: attachPageEnvelope(hit.page, decision),
          snippet: hit.snippet,
          passages: hit.passages,
          score: hit.score,
        })),
        toKnowledgePaginationMeta(result.meta, false, undefined),
      )
    }

    const result = await provider.searchPages({
      ...body,
      organizationId,
      projectId,
      viewer,
    })
    // `total` omitted: this is the same free-text search endpoint's keyword
    // fallback (ranked search per the pagination contract) — its matching
    // predicate lives in the provider's raw SQL (native-search.ts), so a
    // separate count would either fork that WHERE clause or drift from it.
    return createApiResponse(
      result.data.map((hit) => ({
        page: attachPageEnvelope(hit.page, decision),
        snippet: hit.snippet,
      })),
      toKnowledgePaginationMeta(result.meta, Boolean(body.cursor), result.data.at(0)?.page),
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
    // Agents draft; only a human may publish. Agents request publication via
    // kb_publish_request, which opens a knowledge.page.publish approval instead.
    if (actorContext.actor.actorType === 'agent') {
      sendApiError(
        reply,
        403,
        'POLICY_DENIED',
        'Agents cannot publish knowledge pages directly — request publication via approval instead',
      )
      return reply
    }
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
        actorUserId: actorContext.actor.actorType === 'user' ? actorContext.actor.actorId : null,
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
