import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { UoaBillingError } from '../services/uoa-billing-client.js'
import {
  confirmUoaBillingRecurringAddonCancellation,
  createUoaBillingAutoTopUpSetup,
  createUoaBillingCreditTopUp,
  createUoaBillingRecurringAddonCancellationPreview,
  createUoaBillingRecurringAddonCheckout,
  disableUoaBillingAutoTopUp,
  getUoaBillingCredits,
  getUoaBillingRecurringAddons,
  recoverUoaBillingAutoTopUp,
  updateUoaBillingAutoTopUp,
} from '../services/uoa-billing-funding.js'
import { parseBillingCancellationConfirmRequest } from '../services/uoa-billing-protocol.js'
import {
  confirmUoaBillingCancellation,
  createUoaBillingCancellationPreview,
  executeUoaBillingHostedAction,
  getUoaBillingStatement,
} from '../services/uoa-billing-statement.js'
import type { RouteDeps } from './types.js'

const EmptyBodySchema = z.object({}).strict()
const StatementQuerySchema = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/)
      .optional(),
  })
  .strict()
const OfferParamsSchema = z.object({ offerId: z.string().min(1).max(256) }).strict()
const OptionParamsSchema = z.object({ optionId: z.string().min(1).max(256) }).strict()
const SubscriptionParamsSchema = z
  .object({ subscriptionId: z.string().min(1).max(256) })
  .strict()
const AddonCancellationConfirmSchema = z.object({
  preview_token: z.string().min(32).max(256),
  idempotency_key: z.string().min(16).max(200),
  choice: z.literal('cancel_addon'),
}).strict()

const requireBillingManager = (
  roles: string[] | undefined,
  reply: FastifyReply,
): boolean => {
  if (roles?.some((role) => role === 'owner' || role === 'admin')) {
    return true
  }
  sendApiError(reply, 403, 'FORBIDDEN', 'Owner or admin access required')
  return false
}

const sendBillingError = (
  reply: FastifyReply,
  error: unknown,
): FastifyReply | null => {
  if (!(error instanceof UoaBillingError)) return null
  sendApiError(reply, error.statusCode, error.code, error.message)
  return reply
}

export const registerBillingRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { prisma, requireActorContext } = deps

  app.get('/api/billing/credits', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    try {
      reply.header('Cache-Control', 'private, no-store')
      return createApiResponse(
        await getUoaBillingCredits(prisma, actorContext),
      )
    } catch (error) {
      const response = sendBillingError(reply, error)
      if (response) return response
      throw error
    }
  })

  app.get('/api/billing/recurring-addons', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    try {
      reply.header('Cache-Control', 'private, no-store')
      return createApiResponse(
        await getUoaBillingRecurringAddons(prisma, actorContext),
      )
    } catch (error) {
      const response = sendBillingError(reply, error)
      if (response) return response
      throw error
    }
  })

  app.post('/api/billing/credits/top-ups/:offerId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireBillingManager(actorContext.actor.roles, reply)) return reply
    const params = parseInput(OfferParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    if (!parseInput(EmptyBodySchema, request.body ?? {}, reply)) return reply
    try {
      reply.header('Cache-Control', 'private, no-store')
      return createApiResponse(
        await createUoaBillingCreditTopUp(
          prisma,
          actorContext,
          params.offerId,
        ),
      )
    } catch (error) {
      const response = sendBillingError(reply, error)
      if (response) return response
      throw error
    }
  })

  app.post(
    '/api/billing/credits/auto-top-up/options/:optionId/setup',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply
      if (!requireBillingManager(actorContext.actor.roles, reply)) return reply
      const params = parseInput(OptionParamsSchema, request.params, reply, 'params')
      if (!params) return reply
      if (!parseInput(EmptyBodySchema, request.body ?? {}, reply)) return reply
      try {
        reply.header('Cache-Control', 'private, no-store')
        return createApiResponse(
          await createUoaBillingAutoTopUpSetup(
            prisma,
            actorContext,
            params.optionId,
          ),
        )
      } catch (error) {
        const response = sendBillingError(reply, error)
        if (response) return response
        throw error
      }
    },
  )

  app.post(
    '/api/billing/credits/auto-top-up/options/:optionId/select',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply
      if (!requireBillingManager(actorContext.actor.roles, reply)) return reply
      const params = parseInput(OptionParamsSchema, request.params, reply, 'params')
      if (!params) return reply
      if (!parseInput(EmptyBodySchema, request.body ?? {}, reply)) return reply
      try {
        await updateUoaBillingAutoTopUp(
          prisma,
          actorContext,
          params.optionId,
        )
        return reply
          .header('Cache-Control', 'private, no-store')
          .status(204)
          .send()
      } catch (error) {
        const response = sendBillingError(reply, error)
        if (response) return response
        throw error
      }
    },
  )

  app.post('/api/billing/credits/auto-top-up/disable', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireBillingManager(actorContext.actor.roles, reply)) return reply
    if (!parseInput(EmptyBodySchema, request.body ?? {}, reply)) return reply
    try {
      await disableUoaBillingAutoTopUp(prisma, actorContext)
      return reply
        .header('Cache-Control', 'private, no-store')
        .status(204)
        .send()
    } catch (error) {
      const response = sendBillingError(reply, error)
      if (response) return response
      throw error
    }
  })

  app.post('/api/billing/credits/auto-top-up/recover', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireBillingManager(actorContext.actor.roles, reply)) return reply
    if (!parseInput(EmptyBodySchema, request.body ?? {}, reply)) return reply
    try {
      reply.header('Cache-Control', 'private, no-store')
      return createApiResponse(
        await recoverUoaBillingAutoTopUp(prisma, actorContext),
      )
    } catch (error) {
      const response = sendBillingError(reply, error)
      if (response) return response
      throw error
    }
  })

  app.post(
    '/api/billing/recurring-addons/offers/:offerId/subscribe',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply
      if (!requireBillingManager(actorContext.actor.roles, reply)) return reply
      const params = parseInput(OfferParamsSchema, request.params, reply, 'params')
      if (!params) return reply
      if (!parseInput(EmptyBodySchema, request.body ?? {}, reply)) return reply
      try {
        reply.header('Cache-Control', 'private, no-store')
        return createApiResponse(
          await createUoaBillingRecurringAddonCheckout(
            prisma,
            actorContext,
            params.offerId,
          ),
        )
      } catch (error) {
        const response = sendBillingError(reply, error)
        if (response) return response
        throw error
      }
    },
  )

  app.post(
    '/api/billing/recurring-addons/subscriptions/:subscriptionId/cancellation/preview',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply
      if (!requireBillingManager(actorContext.actor.roles, reply)) return reply
      const params = parseInput(
        SubscriptionParamsSchema,
        request.params,
        reply,
        'params',
      )
      if (!params) return reply
      if (!parseInput(EmptyBodySchema, request.body ?? {}, reply)) return reply
      try {
        reply.header('Cache-Control', 'private, no-store')
        return createApiResponse(
          await createUoaBillingRecurringAddonCancellationPreview(
            prisma,
            actorContext,
            params.subscriptionId,
          ),
        )
      } catch (error) {
        const response = sendBillingError(reply, error)
        if (response) return response
        throw error
      }
    },
  )

  app.post(
    '/api/billing/recurring-addons/cancellation/confirm',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply
      if (!requireBillingManager(actorContext.actor.roles, reply)) return reply
      const body = parseInput(
        AddonCancellationConfirmSchema,
        request.body,
        reply,
      )
      if (!body) return reply
      try {
        reply.header('Cache-Control', 'private, no-store')
        return createApiResponse(
          await confirmUoaBillingRecurringAddonCancellation(
            prisma,
            actorContext,
            body,
          ),
        )
      } catch (error) {
        const response = sendBillingError(reply, error)
        if (response) return response
        throw error
      }
    },
  )

  app.get('/api/billing/statement', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireBillingManager(actorContext.actor.roles, reply)) return reply
    const query = parseInput(StatementQuerySchema, request.query, reply, 'query')
    if (!query) return reply
    try {
      reply.header('Cache-Control', 'private, no-store')
      return createApiResponse(
        await getUoaBillingStatement(
          prisma,
          actorContext,
          query.month,
        ),
      )
    } catch (error) {
      const response = sendBillingError(reply, error)
      if (response) return response
      throw error
    }
  })

  const registerHostedAction = (id: 'portal' | 'upgrade'): void => {
    app.post(`/api/billing/actions/${id}`, async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply
      if (!requireBillingManager(actorContext.actor.roles, reply)) return reply
      if (!parseInput(EmptyBodySchema, request.body ?? {}, reply)) return reply
      try {
        reply.header('Cache-Control', 'private, no-store')
        return createApiResponse(
          await executeUoaBillingHostedAction(
            prisma,
            actorContext,
            id,
          ),
        )
      } catch (error) {
        const response = sendBillingError(reply, error)
        if (response) return response
        throw error
      }
    })
  }

  registerHostedAction('upgrade')
  registerHostedAction('portal')

  app.post('/api/billing/cancellation/preview', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireBillingManager(actorContext.actor.roles, reply)) return reply
    if (!parseInput(EmptyBodySchema, request.body ?? {}, reply)) return reply
    try {
      reply.header('Cache-Control', 'private, no-store')
      return createApiResponse(
        await createUoaBillingCancellationPreview(
          prisma,
          actorContext,
        ),
      )
    } catch (error) {
      const response = sendBillingError(reply, error)
      if (response) return response
      throw error
    }
  })

  app.post('/api/billing/cancellation/confirm', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireBillingManager(actorContext.actor.roles, reply)) return reply
    const body = parseBillingCancellationConfirmRequest(request.body)
    if (!body) {
      sendApiError(
        reply,
        400,
        'VALIDATION_ERROR',
        'Invalid billing cancellation confirmation',
      )
      return reply
    }
    try {
      reply.header('Cache-Control', 'private, no-store')
      return createApiResponse(
        await confirmUoaBillingCancellation(
          prisma,
          actorContext,
          body,
        ),
      )
    } catch (error) {
      const response = sendBillingError(reply, error)
      if (response) return response
      throw error
    }
  })
}
