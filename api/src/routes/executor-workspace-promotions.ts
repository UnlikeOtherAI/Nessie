import {
  confirmExecutorWorkspacePromotion,
  ExecutorError,
  getExecutorWorkspacePromotionForUser,
  listOriginatingExecutorWorkspaceReviews,
  prepareExecutorWorkspacePromotion,
  rejectExecutorWorkspacePromotion,
  resolveExecutorAvailabilityCandidates,
} from '@nessie/executor-manage'
import type { FastifyInstance } from 'fastify'

import {
  ConfirmExecutorAccessChangeBodySchema,
  ExecutorWorkspacePromotionPrepareBodySchema,
  ExecutorWorkspacePromotionRecordSchema,
  OriginatingExecutorWorkspaceReviewRecordSchema,
  PreparedExecutorWorkspacePromotionSchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { requireFreshExecutorPasswordVerification } from './executor-fresh-verification.js'
import { sendExecutorError } from './executor-route-errors.js'
import type { RouteDeps } from './types.js'

/**
 * A promotion is a user-owned continuation from one acknowledged review. It
 * intentionally has its own routes: executor managers may inspect reviews,
 * but only the person who originated a run can prepare or confirm its draft.
 */
export const registerExecutorWorkspacePromotionRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { authSecret, config, prisma, rateLimiter, requireActorContext, requireUserActor } = deps

  app.get('/api/executor-workspace-reviews/mine', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !requireUserActor(actorContext, reply)) return reply
    const reviews = await listOriginatingExecutorWorkspaceReviews(prisma, authSecret, actorContext)
    return createApiResponse(OriginatingExecutorWorkspaceReviewRecordSchema.array().parse(reviews))
  })

  app.post('/api/executor-workspace-promotions', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !requireUserActor(actorContext, reply)) return reply
    const body = parseInput(ExecutorWorkspacePromotionPrepareBodySchema, request.body, reply)
    if (!body) return reply
    try {
      const prepared = await prepareExecutorWorkspacePromotion(
        prisma,
        authSecret,
        actorContext,
        body,
      )
      await emitAuditEvent(prisma, {
        action: 'executor.workspace_promotion.prepared',
        actorContext,
        metadata: {
          executorId: prepared.executorId,
          manifestDigest: prepared.manifestDigest,
          reviewChangeCount: prepared.changeCount,
          runId: prepared.runId,
        },
        outcome: 'success',
        resourceId: prepared.promotionId,
        resourceType: 'executor_workspace_promotion',
      })
      return createApiResponse(PreparedExecutorWorkspacePromotionSchema.parse({
        ...prepared,
        expiresAt: prepared.expiresAt.toISOString(),
      }))
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/executor-workspace-promotions/:promotionId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !requireUserActor(actorContext, reply)) return reply
    const { promotionId } = request.params as { promotionId: string }
    const promotion = await getExecutorWorkspacePromotionForUser(prisma, actorContext, promotionId)
    if (!promotion) {
      sendApiError(reply, 404, 'EXECUTOR_PROMOTION_NOT_FOUND', 'Workspace promotion not found')
      return reply
    }
    return createApiResponse(ExecutorWorkspacePromotionRecordSchema.parse({
      ...promotion,
      expiresAt: promotion.expiresAt.toISOString(),
    }))
  })

  app.post('/api/executor-workspace-promotions/:promotionId/confirm', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !requireUserActor(actorContext, reply)) return reply
    const body = parseInput(ConfirmExecutorAccessChangeBodySchema, request.body, reply)
    if (!body) return reply
    const { promotionId } = request.params as { promotionId: string }
    const promotion = await getExecutorWorkspacePromotionForUser(prisma, actorContext, promotionId)
    if (!promotion) {
      sendApiError(reply, 404, 'EXECUTOR_PROMOTION_NOT_FOUND', 'Workspace promotion not found')
      return reply
    }
    const freshVerificationSatisfied = await requireFreshExecutorPasswordVerification({
      actorContext,
      currentPassword: body.currentPassword,
      prisma,
      rateLimit: config.api.rateLimit,
      rateLimiter,
      reply,
      request,
    })
    if (!freshVerificationSatisfied) return reply
    try {
      const availability = await resolveExecutorAvailabilityCandidates(prisma, actorContext, {
        agentId: promotion.agentId,
        executorId: promotion.executorId,
        operationKeys: ['workspace.promote'],
        runId: promotion.runId,
      })
      const candidate = availability.candidates[0]
      if (!candidate) {
        throw new ExecutorError(
          'EXECUTOR_PROMOTION_UNAVAILABLE',
          'The executor is no longer available to promote this reviewed draft.',
        )
      }
      const confirmed = await confirmExecutorWorkspacePromotion(prisma, actorContext, {
        candidateHandle: candidate.handle,
        confirmationToken: body.confirmationToken,
        encryptionSecret: authSecret,
        freshVerificationSatisfied,
        promotionId,
      })
      await emitAuditEvent(prisma, {
        action: 'executor.workspace_promotion.confirmed',
        actorContext,
        metadata: {
          commandId: confirmed.commandId,
          executorId: confirmed.executorId,
          runId: confirmed.runId,
        },
        outcome: 'success',
        resourceId: confirmed.promotionId,
        resourceType: 'executor_workspace_promotion',
      })
      return createApiResponse(confirmed)
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/executor-workspace-promotions/:promotionId/reject', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !requireUserActor(actorContext, reply)) return reply
    const body = parseInput(ConfirmExecutorAccessChangeBodySchema, request.body, reply)
    if (!body) return reply
    const { promotionId } = request.params as { promotionId: string }
    try {
      const rejected = await rejectExecutorWorkspacePromotion(prisma, actorContext, {
        confirmationToken: body.confirmationToken,
        promotionId,
      })
      await emitAuditEvent(prisma, {
        action: 'executor.workspace_promotion.rejected',
        actorContext,
        metadata: { executorId: rejected.executorId },
        outcome: 'success',
        resourceId: rejected.promotionId,
        resourceType: 'executor_workspace_promotion',
      })
      return createApiResponse({ rejected: true })
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })
}
