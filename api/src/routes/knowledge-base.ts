import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  buildNativeSourceRef,
  buildSpaceSourceRef,
  createNativeKnowledgeProvider,
  type KnowledgePageRecord,
  type KnowledgeProvider,
  type KnowledgeSpaceRecord,
} from '@nessie/knowledge'
import type {
  AuthorizedActionContext,
  PolicyAction,
  PolicyDecision,
  PolicyResourceType,
} from '@nessie/schemas'
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
import { checkPolicy } from '../services/policy.js'
import type { RouteDeps } from './types.js'

type KnowledgeRouteDeps = RouteDeps & {
  knowledgeProvider?: KnowledgeProvider
}

const policyTrace = (decision: PolicyDecision): string[] => [
  `decision:${decision.reasonCode}`,
  `source:${decision.policySource}`,
  ...(decision.policyRuleId ? [`rule:${decision.policyRuleId}`] : []),
]

const visibilityReason = (
  record: { sensitivityTier?: string; visibility?: string },
  decision: PolicyDecision,
): string =>
  `${record.visibility ?? 'unknown'} visibility, ${record.sensitivityTier ?? 'normal'} sensitivity, ${decision.reasonCode}`

const pageVersionRef = (page: KnowledgePageRecord): string | null =>
  page.publishedVersion?.id ?? page.latestVersion?.id ?? page.publishedVersionId

const attachSpaceEnvelope = (
  space: KnowledgeSpaceRecord,
  decision: PolicyDecision,
) => ({
  ...space,
  policyChainTrace: policyTrace(decision),
  sourceRef: buildSpaceSourceRef(space.id),
  visibilityReason: visibilityReason(space, decision),
})

const attachPageEnvelope = (
  page: KnowledgePageRecord,
  decision: PolicyDecision,
) => ({
  ...page,
  policyChainTrace: policyTrace(decision),
  sourceRef: buildNativeSourceRef(page.id, pageVersionRef(page)),
  visibilityReason: visibilityReason(page, decision),
})

const requireKnowledgePolicy = async (
  deps: RouteDeps,
  actorContext: AuthorizedActionContext,
  reply: FastifyReply,
  resourceType: PolicyResourceType,
  action: PolicyAction,
): Promise<PolicyDecision | null> => {
  const decision = await checkPolicy(deps.prisma, actorContext, resourceType, action)
  if (!decision.allowed) {
    sendApiError(reply, 403, 'POLICY_DENIED', `Knowledge base access denied: ${decision.reasonCode}`)
    return null
  }
  return decision
}

const requireProjectId = (
  actorContext: AuthorizedActionContext,
  bodyProjectId: string | undefined,
  reply: FastifyReply,
): string | null => {
  const projectId = bodyProjectId ?? actorContext.tenant.projectId
  if (!projectId) {
    sendApiError(reply, 400, 'PROJECT_REQUIRED', 'Knowledge base actions require a projectId')
    return null
  }
  return projectId
}

const actorAuthorType = (
  actorContext: AuthorizedActionContext,
  requested?: 'user' | 'agent',
): 'user' | 'agent' =>
  requested ?? (actorContext.actor.actorType === 'agent' ? 'agent' : 'user')

const requestIds = (request: FastifyRequest) => ({
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
})

const mutationErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Knowledge base mutation failed'

export const registerKnowledgeBaseRoutes = (
  app: FastifyInstance,
  deps: KnowledgeRouteDeps,
): void => {
  const { prisma, requireActorContext } = deps
  const provider = deps.knowledgeProvider ?? createNativeKnowledgeProvider(prisma)

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
    const result = await provider.listSpaces({
      organizationId: actorContext.tenant.organizationId,
      projectId: query.projectId ?? actorContext.tenant.projectId ?? undefined,
      cursor: query.cursor,
      limit: query.limit,
    })
    return createApiResponse(result.data.map((space) => attachSpaceEnvelope(space, decision)), result.meta)
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
    return reply.code(201).send(createApiResponse(attachSpaceEnvelope(space, decision)))
  })

  app.get('/api/knowledge-base/spaces/:spaceId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_space', 'view')
    if (!decision) return reply
    const { spaceId } = request.params as { spaceId: string }
    const space = await provider.getSpace(actorContext.tenant.organizationId, spaceId)
    if (!space) return sendApiError(reply, 404, 'KNOWLEDGE_SPACE_NOT_FOUND', 'Space not found')
    return createApiResponse(attachSpaceEnvelope(space, decision))
  })

  app.patch('/api/knowledge-base/spaces/:spaceId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(UpdateKnowledgeSpaceBodySchema, request.body, reply)
    if (!body) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_space', 'edit')
    if (!decision) return reply
    const { spaceId } = request.params as { spaceId: string }
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
    return createApiResponse(attachSpaceEnvelope(space, decision))
  })

  app.delete('/api/knowledge-base/spaces/:spaceId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_space', 'edit')
    if (!decision) return reply
    const { spaceId } = request.params as { spaceId: string }
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
    return createApiResponse(attachSpaceEnvelope(space, decision))
  })

  app.get('/api/knowledge-base/spaces/:spaceId/pages', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const query = parseInput(KnowledgeListQuerySchema, request.query, reply, 'query')
    if (!query) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'view')
    if (!decision) return reply
    const { spaceId } = request.params as { spaceId: string }
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
    let page: KnowledgePageRecord
    try {
      page = await provider.createPage({
        ...body,
        organizationId: actorContext.tenant.organizationId,
        projectId,
        spaceId,
        authorId: actorContext.actor.actorId,
        authorType: actorAuthorType(actorContext, body.authorType),
        createdBy: actorContext.actor.actorId,
      })
    } catch (error) {
      return sendApiError(reply, 400, 'KNOWLEDGE_PAGE_INVALID', mutationErrorMessage(error))
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
    const result = await provider.searchPages({
      ...body,
      organizationId: actorContext.tenant.organizationId,
      projectId: body.projectId ?? actorContext.tenant.projectId ?? undefined,
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
    const page = await provider.updatePage(pageId, {
      ...body,
      organizationId: actorContext.tenant.organizationId,
      authorId: actorContext.actor.actorId,
      authorType: actorAuthorType(actorContext, body.authorType),
    })
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
    const page = await provider.publishPage({
      organizationId: actorContext.tenant.organizationId,
      pageId,
    })
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
    let page: KnowledgePageRecord | null
    try {
      page = await provider.movePage({
        organizationId: actorContext.tenant.organizationId,
        pageId,
        parentPageId: body.parentPageId,
        position: body.position,
      })
    } catch (error) {
      return sendApiError(reply, 400, 'KNOWLEDGE_PAGE_MOVE_INVALID', mutationErrorMessage(error))
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
    const page = await provider.restoreVersion({
      organizationId: actorContext.tenant.organizationId,
      pageId,
      versionId,
      authorId: actorContext.actor.actorId,
      authorType: actorAuthorType(actorContext, body.authorType),
      changeComment: body.changeComment,
    })
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
