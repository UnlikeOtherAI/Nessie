import type { FastifyInstance } from 'fastify'
import { attributionFromActorContext } from '@nessie/runtime'
import { SearchSummaryBodySchema, type SearchSummaryResponse } from '../contracts/knowledge-base.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { getQueryEmbedding } from '../services/knowledge-query-embedding.js'
import { buildSummaryPassages, synthesizeSummary } from '../services/knowledge-summary.js'
import {
  createKnowledgeAccess,
  policyTrace,
  requireKnowledgePolicy,
  requestIds,
  type KnowledgeRouteDeps,
} from './knowledge-base-access.js'

const noMatchesResponse = (policyChainTrace: string[]): SearchSummaryResponse => ({
  answer: null,
  citations: [],
  sources: [],
  reason: 'no_matches',
  policyChainTrace,
})

// Opt-in `search.summary`: a bounded, cited answer synthesized from the top
// hybrid-search chunks. Reuses the exact policy gate, viewer build, and
// hybrid-search call from POST /api/knowledge-base/search — only the
// synthesis step (passage selection, prompting, model call, citation
// validation) is new, and that logic lives in ../services/knowledge-summary.ts
// so it can be unit-tested without HTTP.
export const registerKnowledgeSummaryRoutes = (
  app: FastifyInstance,
  deps: KnowledgeRouteDeps,
): void => {
  const { prisma, requireActorContext } = deps
  const { provider, buildViewer } = createKnowledgeAccess(deps)

  app.post('/api/knowledge-base/search-summary', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(SearchSummaryBodySchema, request.body, reply)
    if (!body) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'search')
    if (!decision) return reply

    const modelClient = deps.sharedModelClient
    if (!modelClient) {
      sendApiError(reply, 503, 'MODEL_UNAVAILABLE', 'No model client is configured for knowledge summaries')
      return reply
    }

    const hybridSearch = provider.searchPagesHybrid
    if (!hybridSearch) {
      sendApiError(reply, 503, 'SEARCH_UNAVAILABLE', 'Hybrid search is not available for this knowledge provider')
      return reply
    }

    const viewer = await buildViewer(actorContext)
    const organizationId = actorContext.tenant.organizationId
    // Explicit-only: the summary searches the same corpus as
    // POST /api/knowledge-base/search, and narrowing to the session's project
    // would answer from a strict subset of what the caller may read.
    const projectId = body.projectId
    const query = body.query.trim()
    const trace = policyTrace(decision)

    const queryEmbedding = await getQueryEmbedding(
      modelClient,
      query,
      attributionFromActorContext(actorContext, {
        systemComponent: 'knowledge-query-embedding',
      }),
    )
    const result = await hybridSearch({
      organizationId,
      query,
      queryEmbedding,
      viewer,
      projectId,
      spaceId: body.spaceId,
      taskId: body.taskId,
      limit: body.limit,
    })

    if (result.data.length === 0) {
      return createApiResponse(noMatchesResponse(trace))
    }

    const passages = buildSummaryPassages(result.data)
    if (passages.length === 0) {
      return createApiResponse(noMatchesResponse(trace))
    }

    const synthesis = await synthesizeSummary({
      modelClient,
      query,
      passages,
      usage: attributionFromActorContext(actorContext, {
        systemComponent: 'knowledge-summary',
      }),
    })
    if (!synthesis) {
      sendApiError(reply, 502, 'MODEL_OUTPUT_INVALID', 'The model did not return a valid summary')
      return reply
    }

    const hitByPageId = new Map(result.data.map((hit) => [hit.page.id, hit]))
    const citations = synthesis.citations.map((citation) => {
      const hit = hitByPageId.get(citation.pageId)
      return {
        pageId: citation.pageId,
        title: hit?.page.title ?? '',
        spaceId: hit?.page.spaceId ?? '',
        quote: citation.quote,
      }
    })
    const contributingPageIds = [...new Set(passages.map((passage) => passage.pageId))]
    const sources = contributingPageIds.map((pageId) => {
      const hit = hitByPageId.get(pageId)
      return {
        pageId,
        title: hit?.page.title ?? '',
        spaceId: hit?.page.spaceId ?? '',
        snippet: hit?.snippet ?? '',
      }
    })

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'kb.search.summarized',
      resourceType: 'knowledge_page',
      outcome: 'success',
      metadata: {
        queryLength: query.length,
        chunkCount: passages.length,
        citationCount: citations.length,
      },
      ...requestIds(request),
    })

    return createApiResponse({
      answer: synthesis.answer,
      citations,
      sources,
      policyChainTrace: trace,
    })
  })
}
