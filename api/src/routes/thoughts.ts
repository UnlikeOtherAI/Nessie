import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  CaptureThoughtBodySchema,
  LinkThoughtsBodySchema,
  RecordOutcomeBodySchema,
  RecordThoughtRecallSignalBodySchema,
  SearchThoughtsBodySchema,
} from '@nessie/schemas'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  resolveThoughtCaptureAudience,
  resolveThoughtOutputAudience,
} from '../services/thought-audiences.js'
import type { RouteDeps } from './types.js'

export const registerThoughtRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { requireActorContext, requireUserActor, thoughtService } = deps

  const requireThoughtService = (reply: FastifyReply) => {
    if (!thoughtService) {
      sendApiError(reply, 503, 'SERVICE_UNAVAILABLE', 'Memory service not configured')
      return null
    }
    return thoughtService
  }

  app.post('/api/thoughts', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(CaptureThoughtBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const ts = requireThoughtService(reply)
    if (!ts) return reply

    const projectId = body.projectId ?? actorContext.tenant.projectId
    const teamId = body.teamId
      ?? actorContext.actionContext.teamId
      ?? actorContext.tenant.teamId
    const channelId = body.channelId
      ?? actorContext.actionContext.channelId
      ?? actorContext.tenant.channelId
      ?? undefined
    const captureAudience = resolveThoughtCaptureAudience(actorContext, {
      audienceType: body.audienceType,
      visibility: body.visibility,
      projectId,
      teamId,
      channelId,
    })
    if (!captureAudience.audience) {
      return sendApiError(reply, 400, 'INVALID_MEMORY_AUDIENCE', captureAudience.error)
    }

    const result = await ts.capture({
      content: body.content,
      ownerId: actorContext.actor.actorId,
      ownerType: actorContext.actor.actorType,
      audienceType: captureAudience.audience.audienceType,
      audienceId: captureAudience.audience.audienceId,
      organizationId: actorContext.tenant.organizationId,
      projectId,
      teamId,
      channelId,
      threadId: body.threadId ?? undefined,
      userId: captureAudience.audience.audienceType === 'user'
        ? captureAudience.audience.audienceId
        : undefined,
      visibility: captureAudience.audience.visibility,
      sensitivityTier: body.sensitivityTier,
      importance: body.importance,
    })

    return reply.code(201).send(createApiResponse(result))
  })

  app.post('/api/thoughts/search', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireUserActor(actorContext, reply)) {
      return reply
    }

    const body = parseInput(SearchThoughtsBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const ts = requireThoughtService(reply)
    if (!ts) return reply

    const outputAudience = resolveThoughtOutputAudience(actorContext)
    if (!outputAudience.audience) {
      return sendApiError(reply, 400, 'INVALID_MEMORY_AUDIENCE', outputAudience.error)
    }

    try {
      const results = await ts.search({
        query: body.query,
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
        outputAudienceType: outputAudience.audience.audienceType,
        outputAudienceId: outputAudience.audience.audienceId,
        threshold: body.threshold,
        limit: body.limit,
        includeReasoning: body.includeReasoning,
        mode: body.mode,
        sessionId: actorContext.actionContext.sessionId,
        channelId:
          actorContext.actionContext.channelId ?? actorContext.tenant.channelId,
      })
      return createApiResponse(results)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Search failed'
      return sendApiError(reply, 502, 'SEARCH_FAILED', msg)
    }
  })

  app.put('/api/thoughts/:id/outcome', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireUserActor(actorContext, reply)) {
      return reply
    }

    const body = parseInput(RecordOutcomeBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const ts = requireThoughtService(reply)
    if (!ts) return reply

    const { id } = request.params as { id: string }
    const outputAudience = resolveThoughtOutputAudience(actorContext)
    if (!outputAudience.audience) {
      return sendApiError(reply, 400, 'INVALID_MEMORY_AUDIENCE', outputAudience.error)
    }

    const hasAccess = await ts.verifyAccess({
      thoughtId: id,
      organizationId: actorContext.tenant.organizationId,
      requesterUserId: actorContext.actor.actorId,
      outputAudienceType: outputAudience.audience.audienceType,
      outputAudienceId: outputAudience.audience.audienceId,
    })
    if (!hasAccess) {
      return sendApiError(reply, 404, 'THOUGHT_NOT_FOUND', 'Thought not found')
    }

    await ts.recordOutcome({
      thoughtId: id,
      organizationId: actorContext.tenant.organizationId,
      outcome: body.outcome,
      outcomeNotes: body.outcomeNotes,
      actorType: actorContext.actor.actorType,
      actorId: actorContext.actor.actorId,
    })

    return createApiResponse({ ok: true })
  })

  app.put('/api/thoughts/recalls/:id/signal', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireUserActor(actorContext, reply)) {
      return reply
    }

    const body = parseInput(RecordThoughtRecallSignalBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const ts = requireThoughtService(reply)
    if (!ts) return reply

    const { id } = request.params as { id: string }
    const updated = await ts.recordRecallSignal({
      recallId: id,
      organizationId: actorContext.tenant.organizationId,
      requesterUserId: actorContext.actor.actorId,
      userSignal: body.userSignal,
    })

    if (!updated) {
      return sendApiError(reply, 404, 'THOUGHT_RECALL_NOT_FOUND', 'Thought recall not found')
    }

    return createApiResponse({ ok: true })
  })

  app.post('/api/thoughts/:id/link', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireUserActor(actorContext, reply)) {
      return reply
    }

    const body = parseInput(LinkThoughtsBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const ts = requireThoughtService(reply)
    if (!ts) return reply

    const { id } = request.params as { id: string }
    const outputAudience = resolveThoughtOutputAudience(actorContext)
    if (!outputAudience.audience) {
      return sendApiError(reply, 400, 'INVALID_MEMORY_AUDIENCE', outputAudience.error)
    }

    // Verify both source and target are readable in the caller's current audience.
    const [sourceOk, targetOk] = await Promise.all([
      ts.verifyAccess({
        thoughtId: id,
        organizationId: actorContext.tenant.organizationId,
        requesterUserId: actorContext.actor.actorId,
        outputAudienceType: outputAudience.audience.audienceType,
        outputAudienceId: outputAudience.audience.audienceId,
      }),
      ts.verifyAccess({
        thoughtId: body.targetId,
        organizationId: actorContext.tenant.organizationId,
        requesterUserId: actorContext.actor.actorId,
        outputAudienceType: outputAudience.audience.audienceType,
        outputAudienceId: outputAudience.audience.audienceId,
      }),
    ])
    if (!sourceOk || !targetOk) {
      return sendApiError(reply, 404, 'THOUGHT_NOT_FOUND', 'Thought not found')
    }

    const linkId = await ts.link({
      sourceId: id,
      targetId: body.targetId,
      organizationId: actorContext.tenant.organizationId,
      relation: body.relation,
      metadata: body.metadata,
      actorType: actorContext.actor.actorType,
      actorId: actorContext.actor.actorId,
    })

    if (!linkId) {
      return createApiResponse({ linkId: null, alreadyExists: true })
    }

    return reply.code(201).send(createApiResponse({ linkId }))
  })

  app.get('/api/experience/stats', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const ts = requireThoughtService(reply)
    if (!ts) return reply

    const actorId = (request.query as { actorId?: string }).actorId ?? null

    const stats = await ts.experienceStats(
      actorContext.tenant.organizationId,
      actorId,
    )

    return createApiResponse(stats)
  })
}
