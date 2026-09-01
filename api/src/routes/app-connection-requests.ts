import { BeginAppConnectionRequestSchema } from '@nessie/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  buildAppConnectContext,
  guardAppConnectAttempt,
  sendAppsConnectError,
} from './apps-connect.js'
import {
  APP_CONNECTION_REQUEST_ACTION_ERROR_CODES,
  AppConnectionRequestActionError,
  beginAppConnectionRequest,
} from '../services/app-connection-request-actions.js'
import { getAppConnectionRequestPresenter } from '../services/app-connection-request-presenter.js'
import type { RouteDeps } from './types.js'

const RequestParamsSchema = z.object({ id: z.string().uuid() })

/**
 * The authenticated, viewer-scoped read behind an app-setup message card.
 * Mutations live in a later registrar: keeping this route read-only means a
 * message render can never initiate contact with a third-party service.
 */
export const registerAppConnectionRequestRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  app.get('/api/agent-app-connection-requests/:id', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const params = parseInput(RequestParamsSchema, request.params, reply, 'id')
    if (!params) return reply

    const presenter = await getAppConnectionRequestPresenter(prisma, actorContext, params.id)
    if (!presenter) {
      // Do not distinguish a missing request from one owned by another person.
      sendApiError(reply, 404, 'APP_CONNECTION_REQUEST_NOT_FOUND', 'App connection request not found')
      return reply
    }
    return createApiResponse(presenter)
  })

  app.post('/api/agent-app-connection-requests/:id/begin', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    if (!(await guardAppConnectAttempt(request, reply, actorContext, deps))) return reply

    const params = parseInput(RequestParamsSchema, request.params, reply, 'id')
    if (!params) return reply
    const body = parseInput(BeginAppConnectionRequestSchema, request.body, reply)
    if (!body) return reply
    const context = buildAppConnectContext(request, reply, actorContext, deps)
    if (!context) return reply

    try {
      const result = await beginAppConnectionRequest(
        prisma,
        actorContext,
        params.id,
        body.catalogEntryId,
        context,
      )
      return createApiResponse(result)
    } catch (error) {
      if (error instanceof AppConnectionRequestActionError) {
        const status = error.code === APP_CONNECTION_REQUEST_ACTION_ERROR_CODES.NOT_FOUND ? 404 : 409
        sendApiError(reply, status, error.code, error.message)
        return reply
      }
      if (sendAppsConnectError(reply, error)) return reply
      throw error
    }
  })
}
