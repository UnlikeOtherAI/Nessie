import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { ToolBundleStatusSchema } from '@nessie/schemas'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  deleteBundle,
  getBundle,
  importBundle,
  listBundles,
  transitionBundleStatus,
  ToolBundleError,
  TOOL_BUNDLE_ERROR_CODES,
} from '../services/tool-bundles.js'

/**
 * Routes for admin-driven `NessieToolBundle` import (spec
 * `docs/tool-registry-spec.md` §4.1, plan §6). All endpoints require an owner
 * actor — only owners can publish or revoke tools for the organization.
 */

export type ToolBundleRouteHelpers = {
  prisma: PrismaClient
  requireActorContext: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => AuthorizedActionContext | null
  requireOwner: (actorContext: AuthorizedActionContext, reply: FastifyReply) => boolean
}

const ImportBundleBodySchema = z.object({
  format: z.enum(['json', 'yaml', 'md']).optional(),
  body: z.string().min(1),
})

const TransitionBundleStatusBodySchema = z.object({
  status: ToolBundleStatusSchema,
})

const sendBundleError = (reply: FastifyReply, error: unknown): boolean => {
  if (!(error instanceof ToolBundleError)) return false
  switch (error.code) {
    case TOOL_BUNDLE_ERROR_CODES.PARSE_FAILED:
      sendApiError(reply, 400, error.code, error.message, 'body')
      return true
    case TOOL_BUNDLE_ERROR_CODES.VALIDATION_FAILED:
      sendApiError(reply, 400, error.code, error.message, 'body', { issues: error.issues })
      return true
    case TOOL_BUNDLE_ERROR_CODES.DUPLICATE:
      sendApiError(reply, 409, error.code, error.message)
      return true
    case TOOL_BUNDLE_ERROR_CODES.NOT_FOUND:
      sendApiError(reply, 404, error.code, error.message)
      return true
    default:
      return false
  }
}

export const registerToolBundleRoutes = (
  app: FastifyInstance,
  helpers: ToolBundleRouteHelpers,
): void => {
  const { prisma, requireActorContext, requireOwner } = helpers

  app.get('/api/tools/bundles', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as { status?: string }
    const statusFilter = query.status
      ? ToolBundleStatusSchema.safeParse(query.status)
      : null
    if (statusFilter && !statusFilter.success) {
      sendApiError(reply, 400, 'VALIDATION_ERROR', 'Invalid status filter', 'status')
      return reply
    }

    const bundles = await listBundles(
      prisma,
      actorContext.tenant.organizationId,
      { status: statusFilter?.success ? statusFilter.data : undefined },
    )
    return createApiResponse(bundles)
  })

  app.post('/api/tools/bundles', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(ImportBundleBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const result = await importBundle(prisma, actorContext, {
        body: body.body,
        format: body.format,
      })
      return reply.code(201).send(createApiResponse(result))
    } catch (error) {
      if (sendBundleError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/tools/bundles/:bundleId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { bundleId } = request.params as { bundleId: string }
    const bundle = await getBundle(prisma, actorContext.tenant.organizationId, bundleId)
    if (!bundle) {
      sendApiError(reply, 404, TOOL_BUNDLE_ERROR_CODES.NOT_FOUND, 'Bundle not found')
      return reply
    }
    return createApiResponse(bundle)
  })

  app.post('/api/tools/bundles/:bundleId/transition', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { bundleId } = request.params as { bundleId: string }
    const body = parseInput(TransitionBundleStatusBodySchema, request.body, reply)
    if (!body) return reply

    const bundle = await transitionBundleStatus(
      prisma,
      actorContext.tenant.organizationId,
      bundleId,
      body.status,
    )
    if (!bundle) {
      sendApiError(reply, 404, TOOL_BUNDLE_ERROR_CODES.NOT_FOUND, 'Bundle not found')
      return reply
    }
    return createApiResponse(bundle)
  })

  app.delete('/api/tools/bundles/:bundleId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { bundleId } = request.params as { bundleId: string }
    const deleted = await deleteBundle(prisma, actorContext.tenant.organizationId, bundleId)
    if (!deleted) {
      sendApiError(reply, 404, TOOL_BUNDLE_ERROR_CODES.NOT_FOUND, 'Bundle not found')
      return reply
    }
    return reply.code(204).send()
  })
}
