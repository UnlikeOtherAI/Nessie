import type { FastifyInstance, FastifyReply } from 'fastify'

import { createApiResponse, sendApiError } from '../lib/api.js'
import {
  cancelUoaBillingSubscription,
  createUoaBillingCheckout,
  createUoaBillingPortal,
  getUoaBillingSubscription,
  UoaBillingSubscriptionError,
} from '../services/uoa-billing-subscription.js'
import type { RouteDeps } from './types.js'

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
  if (!(error instanceof UoaBillingSubscriptionError)) return null
  sendApiError(reply, error.statusCode, error.code, error.message)
  return reply
}

export const registerBillingRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { prisma, requireActorContext } = deps

  app.get('/api/billing/subscription', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireBillingManager(actorContext.actor.roles, reply)) return reply
    try {
      reply.header('Cache-Control', 'private, no-store')
      return createApiResponse(
        await getUoaBillingSubscription(prisma, actorContext),
      )
    } catch (error) {
      const response = sendBillingError(reply, error)
      if (response) return response
      throw error
    }
  })

  app.post('/api/billing/checkout', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireBillingManager(actorContext.actor.roles, reply)) return reply
    try {
      reply.header('Cache-Control', 'private, no-store')
      return createApiResponse(
        await createUoaBillingCheckout(prisma, actorContext),
      )
    } catch (error) {
      const response = sendBillingError(reply, error)
      if (response) return response
      throw error
    }
  })

  app.post('/api/billing/portal', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireBillingManager(actorContext.actor.roles, reply)) return reply
    try {
      reply.header('Cache-Control', 'private, no-store')
      return createApiResponse(
        await createUoaBillingPortal(prisma, actorContext),
      )
    } catch (error) {
      const response = sendBillingError(reply, error)
      if (response) return response
      throw error
    }
  })

  app.post('/api/billing/subscription/cancel', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireBillingManager(actorContext.actor.roles, reply)) return reply
    try {
      reply.header('Cache-Control', 'private, no-store')
      return createApiResponse(
        await cancelUoaBillingSubscription(prisma, actorContext),
      )
    } catch (error) {
      const response = sendBillingError(reply, error)
      if (response) return response
      throw error
    }
  })
}
