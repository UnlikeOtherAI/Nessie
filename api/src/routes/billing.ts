import type { FastifyInstance, FastifyReply } from 'fastify'
import { UoaBillingCancellationConfirmRequestSchema } from '@nessie/schemas'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { UoaBillingError } from '../services/uoa-billing-client.js'
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
    const body = parseInput(
      UoaBillingCancellationConfirmRequestSchema,
      request.body,
      reply,
    )
    if (!body) return reply
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
