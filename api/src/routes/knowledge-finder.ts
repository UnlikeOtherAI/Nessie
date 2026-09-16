import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  buildKnowledgeRoot,
  ensureProjectDocumentsSpace,
  getKnowledgePageInfo,
  getKnowledgeSpaceInfo,
  indexingStateFor,
  KnowledgeInferenceOriginError,
  knowledgeEmbeddingJobKey,
  knowledgeExtractRetryJobKey,
  latestKnowledgeExtractJob,
  listNativeLatestPages,
  mapPage,
  pageInclude,
  replaceKnowledgePageVersionChunks,
  type KnowledgePageRecord,
} from '@nessie/knowledge'
import { enqueueQueueJob } from '@nessie/db'
import { KNOWLEDGE_EMBED_TOPIC, KNOWLEDGE_EXTRACT_TOPIC } from '@nessie/schemas'

import {
  KnowledgeItemInfoSchema,
  KnowledgeLatestQuerySchema,
  KnowledgeRootSchema,
} from '../contracts/knowledge-base.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { requireApiKnowledgeInferenceOrigin } from '../services/knowledge-inference-origin.js'
import {
  attachSpaceEnvelope,
  canManageKnowledgeSpaceAccess,
  canViewerReachProject,
  createKnowledgeAccess,
  requireKnowledgePolicy,
  requireProjectId,
  requestIds,
  toKnowledgePaginationMeta,
  type KnowledgeRouteDeps,
} from './knowledge-base-access.js'

/**
 * The Finder's own reads: the root column, Latest, Get Info for a page and for a
 * space, reindex, and provisioning a project's Documents space on first open.
 *
 * New routes land here rather than in `knowledge-base.ts` (666 lines) or
 * `knowledge-base-files.ts` (619), both already past the 500-line cap.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/data-and-api.md §3, §5–7.
 *
 *   GET  /api/knowledge-base/root
 *   GET  /api/knowledge-base/latest
 *   GET  /api/knowledge-base/pages/:pageId/info
 *   GET  /api/knowledge-base/spaces/:spaceId/info
 *   POST /api/knowledge-base/pages/:pageId/reindex
 *   POST /api/knowledge-base/projects/:projectId/documents
 */

// Path ids are guarded before they reach a uuid-typed query: a malformed id is
// a 400, never a database error surfacing as a 500.
const PageParamsSchema = z.object({ pageId: z.string().uuid() })
const SpaceParamsSchema = z.object({ spaceId: z.string().uuid() })
const ProjectParamsSchema = z.object({ projectId: z.string().uuid() })

export const registerKnowledgeFinderRoutes = (
  app: FastifyInstance,
  deps: KnowledgeRouteDeps,
): void => {
  const { prisma, requireActorContext, fileService, isProjectAccessibleToActor } = deps
  const {
    provider,
    buildViewer,
    buildDisclosureViewer,
    accessSpace,
    accessPageSpace,
    filterReadablePages,
  } = createKnowledgeAccess(deps)

  app.get('/api/knowledge-base/root', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    // The root is a person's view of their own documents: My Documents, their
    // projects, what is shared with them. An agent has no such standing place.
    if (actorContext.actor.actorType !== 'user') {
      sendApiError(reply, 403, 'ACTOR_TYPE_NOT_ALLOWED', 'The documents root is a person’s view')
      return reply
    }
    const decision = await requireKnowledgePolicy(
      deps,
      actorContext,
      reply,
      'knowledge_space',
      'view',
    )
    if (!decision) return reply
    const projectId = requireProjectId(actorContext, undefined, reply)
    if (!projectId) return reply
    const viewer = await buildViewer(actorContext)
    const { root, myDocumentsCreated } = await buildKnowledgeRoot(prisma, {
      organizationId: actorContext.tenant.organizationId,
      projectId,
      userId: actorContext.actor.actorId,
      viewer,
      provider,
      canManageAccess: (space) => canManageKnowledgeSpaceAccess(space, actorContext, viewer),
    })
    if (myDocumentsCreated) {
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'kb.space.created',
        resourceType: 'knowledge_space',
        resourceId: root.myDocuments.spaceId,
        outcome: 'success',
        metadata: { name: root.myDocuments.name, personal: true },
        ...requestIds(request),
      })
    }
    return createApiResponse(KnowledgeRootSchema.parse(root))
  })

  app.get('/api/knowledge-base/latest', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const query = parseInput(KnowledgeLatestQuerySchema, request.query, reply, 'query')
    if (!query) return reply
    const decision = await requireKnowledgePolicy(
      deps,
      actorContext,
      reply,
      'knowledge_page',
      'view',
    )
    if (!decision) return reply
    // A project the caller cannot reach is indistinguishable from one that does
    // not exist — the same 404 `recent-pages` returns.
    if (query.projectId && !(await isProjectAccessibleToActor(actorContext, query.projectId))) {
      return sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
    }
    const viewer = await buildViewer(actorContext)
    const result = await listNativeLatestPages(prisma, {
      organizationId: actorContext.tenant.organizationId,
      viewer,
      disclosureViewer: buildDisclosureViewer(viewer) ?? undefined,
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    })
    // The SQL pre-filter is the space rule. The definitive per-version read is
    // the shared one: space membership alone is not sufficient for a
    // private-derived version, and a virtual row names a page the viewer is
    // about to open.
    const rows = await prisma.knowledgePage.findMany({
      where: {
        id: { in: result.data.map((row) => row.id) },
        organizationId: actorContext.tenant.organizationId,
      },
      include: pageInclude,
    })
    const readable = new Set(
      (await filterReadablePages(viewer, rows.map(mapPage))).map((page) => page.id),
    )
    return createApiResponse(
      result.data.filter((row) => readable.has(row.id)),
      toKnowledgePaginationMeta(result.meta),
    )
  })

  // Shared by both Get Info routes: the space read gate plus the "may this
  // person change who can reach it" fact the panel reads out.
  const loadPageForInfo = async (request: FastifyRequest, reply: FastifyReply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return null
    const params = parseInput(PageParamsSchema, request.params, reply, 'params')
    if (!params) return null
    const decision = await requireKnowledgePolicy(
      deps,
      actorContext,
      reply,
      'knowledge_page',
      'view',
    )
    if (!decision) return null
    const page = await provider.getPage(actorContext.tenant.organizationId, params.pageId)
    if (!page) {
      sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
      return null
    }
    const viewer = await buildViewer(actorContext)
    if (!(await accessPageSpace(actorContext, page, viewer, 'read', reply))) return null
    const space = await provider.getSpace(actorContext.tenant.organizationId, page.spaceId)
    if (!space) {
      sendApiError(reply, 404, 'KNOWLEDGE_SPACE_NOT_FOUND', 'Space not found')
      return null
    }
    return { actorContext, page, space, viewer }
  }

  app.get('/api/knowledge-base/pages/:pageId/info', async (request, reply) => {
    const loaded = await loadPageForInfo(request, reply)
    if (!loaded) return reply
    const info = await getKnowledgePageInfo(prisma, {
      organizationId: loaded.actorContext.tenant.organizationId,
      page: loaded.page,
      space: loaded.space,
      viewer: loaded.viewer,
      canManageAccess: canManageKnowledgeSpaceAccess(
        loaded.space,
        loaded.actorContext,
        loaded.viewer,
      ),
    })
    return createApiResponse(KnowledgeItemInfoSchema.parse(info))
  })

  app.get('/api/knowledge-base/spaces/:spaceId/info', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const params = parseInput(SpaceParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const decision = await requireKnowledgePolicy(
      deps,
      actorContext,
      reply,
      'knowledge_space',
      'view',
    )
    if (!decision) return reply
    const viewer = await buildViewer(actorContext)
    const space = await accessSpace(actorContext, params.spaceId, viewer, 'read', reply)
    if (!space) return reply
    // For a space the ledger is exact and already paid for; a sum over the
    // subtree would disagree with the storage meter on the same screen.
    const storageBytes = await fileService.usageForScope({
      organizationId: actorContext.tenant.organizationId,
      spaceId: space.id,
    })
    const info = await getKnowledgeSpaceInfo(prisma, {
      organizationId: actorContext.tenant.organizationId,
      space,
      viewer,
      canManageAccess: canManageKnowledgeSpaceAccess(space, actorContext, viewer),
      storageBytes,
    })
    return createApiResponse(KnowledgeItemInfoSchema.parse(info))
  })

  // A retry cannot reuse the exhausted job's idempotency key — the unique index
  // would swallow it — so it is numbered from the attempts the last one made.
  const enqueueExtractRetry = async (
    page: KnowledgePageRecord,
    versionId: string,
    attachmentId: string,
  ): Promise<void> => {
    const previous = await latestKnowledgeExtractJob(prisma, page.id, versionId)
    const origin = await requireApiKnowledgeInferenceOrigin(
      prisma,
      { organizationId: page.organizationId, pageId: page.id, versionId },
      'knowledge-file-indexer',
    )
    await enqueueQueueJob(prisma, {
      idempotencyKey: knowledgeExtractRetryJobKey(
        page.id,
        versionId,
        (previous?.attempt ?? 0) + 1,
      ),
      payload: {
        organizationId: page.organizationId,
        pageId: page.id,
        versionId,
        attachmentId,
        origin,
      },
      topic: KNOWLEDGE_EXTRACT_TOPIC,
    })
  }

  // A document is chunked in the same transaction that publishes it, so a retry
  // writes the chunks if they are missing and then asks for the embeddings
  // again under a fresh key.
  const reindexDocument = async (
    page: KnowledgePageRecord,
    version: { id: string; body: string | null },
  ): Promise<void> => {
    await prisma.$transaction(async (tx) => {
      await replaceKnowledgePageVersionChunks(tx, {
        page: {
          id: page.id,
          organizationId: page.organizationId,
          projectId: page.projectId,
          teamId: page.teamId ?? null,
          channelId: page.channelId ?? null,
          threadId: page.threadId ?? null,
          userId: page.userId ?? null,
          visibility: page.visibility ?? 'project',
          sensitivityTier: page.sensitivityTier ?? 'normal',
          privateToAgentId: page.privateToAgentId ?? null,
          taskId: page.taskId,
        },
        version,
      })
    })
    const origin = await requireApiKnowledgeInferenceOrigin(
      prisma,
      { organizationId: page.organizationId, pageId: page.id, versionId: version.id },
      'knowledge-indexer',
    )
    const baseKey = knowledgeEmbeddingJobKey(
      page.id,
      version.id,
      deps.sharedModelClient?.embeddingModel ?? 'unresolved',
    )
    await enqueueQueueJob(prisma, {
      idempotencyKey: `${baseKey}:retry:${Date.now()}`,
      payload: {
        organizationId: page.organizationId,
        pageId: page.id,
        versionId: version.id,
        origin,
      },
      topic: KNOWLEDGE_EMBED_TOPIC,
    })
  }

  app.post('/api/knowledge-base/pages/:pageId/reindex', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const params = parseInput(PageParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const decision = await requireKnowledgePolicy(
      deps,
      actorContext,
      reply,
      // `edit` is the seeded page-write gate (policy-seed.ts). The enum also
      // carries a `reindex` action, but no default rule grants it, so gating on
      // it would 403 every retry in an ordinary organisation.
      'knowledge_page',
      'edit',
    )
    if (!decision) return reply
    const organizationId = actorContext.tenant.organizationId
    const page = await provider.getPage(organizationId, params.pageId)
    if (!page) {
      sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
      return reply
    }
    const viewer = await buildViewer(actorContext)
    if (!(await accessPageSpace(actorContext, page, viewer, 'write', reply))) return reply

    const before = await indexingStateFor(prisma, {
      id: page.id,
      kind: page.kind,
      status: page.status,
      publishedVersionId: page.publishedVersionId,
    })
    // The three honest "never will be" reasons and a folder are not retryable:
    // nothing about running the job again would change the answer.
    if (
      before.state === 'not_applicable'
      || (before.state === 'not_indexed' && before.reason !== 'empty')
    ) {
      sendApiError(
        reply,
        400,
        'REINDEX_NOT_APPLICABLE',
        'There is nothing to index for this item',
      )
      return reply
    }
    const version = page.kind === 'file'
      ? page.latestVersion
      : page.publishedVersion ?? page.latestVersion
    if (!version) {
      sendApiError(reply, 400, 'REINDEX_NOT_APPLICABLE', 'There is nothing to index for this item')
      return reply
    }

    try {
      if (page.kind === 'file' && version.attachmentId) {
        await enqueueExtractRetry(page, version.id, version.attachmentId)
      } else {
        await reindexDocument(page, { id: version.id, body: version.body })
      }
    } catch (error) {
      if (error instanceof KnowledgeInferenceOriginError) {
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
      throw error
    }
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'kb.page.reindexed',
      resourceType: 'knowledge_page',
      resourceId: page.id,
      outcome: 'success',
      metadata: { versionId: version.id, stage: page.kind === 'file' ? 'extract' : 'embed' },
      ...requestIds(request),
    })
    const after = await indexingStateFor(prisma, {
      id: page.id,
      kind: page.kind,
      status: page.status,
      publishedVersionId: page.publishedVersionId,
    })
    return reply.code(202).send(createApiResponse({ indexing: after }))
  })

  app.post('/api/knowledge-base/projects/:projectId/documents', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const params = parseInput(ProjectParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const decision = await requireKnowledgePolicy(
      deps,
      actorContext,
      reply,
      'knowledge_space',
      'create',
    )
    if (!decision) return reply
    const viewer = await buildViewer(actorContext)
    const project = await prisma.project.findFirst({
      where: {
        id: params.projectId,
        organizationId: actorContext.tenant.organizationId,
        deletedAt: null,
      },
      select: { id: true },
    })
    // Same 404 as `recent-pages`: a project the caller cannot reach never
    // confirms its own existence.
    if (!project || !canViewerReachProject(viewer, params.projectId)) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    const { spaceId, created } = await ensureProjectDocumentsSpace(prisma, {
      organizationId: actorContext.tenant.organizationId,
      projectId: params.projectId,
      actorId: actorContext.actor.actorId,
    })
    const space = await provider.getSpace(actorContext.tenant.organizationId, spaceId)
    if (!space) {
      sendApiError(reply, 404, 'KNOWLEDGE_SPACE_NOT_FOUND', 'Space not found')
      return reply
    }
    if (created) {
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'kb.space.created',
        resourceType: 'knowledge_space',
        resourceId: spaceId,
        outcome: 'success',
        metadata: { name: space.name, projectDocuments: true },
        ...requestIds(request),
      })
    }
    return createApiResponse(attachSpaceEnvelope(space, decision, viewer, actorContext))
  })
}
