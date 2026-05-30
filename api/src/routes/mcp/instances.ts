import { McpServerScopeTypeSchema, type AuthorizedActionContext } from '@nessie/schemas'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import { isOwnerRole } from '../../services/mcp-catalog.js'
import {
  createInstance,
  deleteInstance,
  getInstance,
  healthcheckInstance,
  listInstances,
  MCP_INSTANCE_ERROR_CODES,
  refreshInstance,
  testInstance,
  type McpInstanceRow,
} from '../../services/mcp-instances.js'

import { JsonRecordSchema, sendMcpError, type McpSubRegistrarContext } from './shared.js'

/**
 * Instances sub-registrar (plan §6,
 * `docs/plans/2026-05-30-mcp-store-publishing-approval.md`).
 *
 * Owns CRUD + lifecycle (`test`, `refresh`, `healthcheck`) on
 * `McpServerInstance`. Superusers (`owner` role) manage installs at any scope;
 * every other user may install and manage connectors only for themselves — i.e.
 * at their own `user` scope (`scopeType === 'user'`, `scopeId === actorId`).
 */

const CreateInstanceBodySchema = z.object({
  catalogEntryId: z.string().uuid(),
  scopeType: McpServerScopeTypeSchema,
  scopeId: z.string().uuid(),
  credentialRef: z.string().nullable().optional(),
  transportConfig: JsonRecordSchema.optional(),
})

/** Whether the actor may operate on the given install scope. */
const canManageScope = (
  actorContext: AuthorizedActionContext,
  scopeType: string,
  scopeId: string,
): boolean =>
  isOwnerRole(actorContext)
  || (scopeType === 'user' && scopeId === actorContext.actor.actorId)

const FORBIDDEN_SCOPE = {
  code: 'MCP_INSTANCE_FORBIDDEN',
  message: 'You can only install or manage connectors for yourself',
}

const denyScope = (reply: FastifyReply): FastifyReply => {
  sendApiError(reply, 403, FORBIDDEN_SCOPE.code, FORBIDDEN_SCOPE.message)
  return reply
}

export const registerMcpInstanceRoutes = (
  app: FastifyInstance,
  ctx: McpSubRegistrarContext,
): void => {
  const { prisma, requireActorContext } = ctx

  /**
   * Load an instance and confirm the actor may manage its scope. Returns the
   * row, or null after writing a 404 / 403 to `reply`.
   */
  const loadManageable = async (
    actorContext: AuthorizedActionContext,
    instanceId: string,
    reply: FastifyReply,
  ): Promise<McpInstanceRow | null> => {
    const instance = await getInstance(
      prisma,
      actorContext.tenant.organizationId,
      instanceId,
    )
    if (!instance) {
      sendApiError(reply, 404, MCP_INSTANCE_ERROR_CODES.NOT_FOUND, 'Instance not found')
      return null
    }
    if (!canManageScope(actorContext, instance.scopeType, instance.scopeId)) {
      denyScope(reply)
      return null
    }
    return instance
  }

  app.get('/api/mcp/instances', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const query = request.query as { scopeType?: string; scopeId?: string }
    const scopeTypeParsed = query.scopeType
      ? McpServerScopeTypeSchema.safeParse(query.scopeType)
      : null
    if (scopeTypeParsed && !scopeTypeParsed.success) {
      sendApiError(reply, 400, 'VALIDATION_ERROR', 'Invalid scopeType filter', 'scopeType')
      return reply
    }

    // Non-superusers only ever see their own user-scope installs, regardless of
    // any filter they pass.
    const filters = isOwnerRole(actorContext)
      ? {
          scopeType: scopeTypeParsed?.success ? scopeTypeParsed.data : undefined,
          scopeId: query.scopeId,
        }
      : { scopeType: 'user' as const, scopeId: actorContext.actor.actorId }

    const instances = await listInstances(
      prisma,
      actorContext.tenant.organizationId,
      filters,
    )
    return createApiResponse(instances)
  })

  app.post('/api/mcp/instances', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(CreateInstanceBodySchema, request.body, reply)
    if (!body) return reply
    if (!canManageScope(actorContext, body.scopeType, body.scopeId)) {
      return denyScope(reply)
    }

    try {
      const instance = await createInstance(prisma, actorContext, body)
      return reply.code(201).send(createApiResponse(instance))
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/mcp/instances/:instanceId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { instanceId } = request.params as { instanceId: string }
    const instance = await loadManageable(actorContext, instanceId, reply)
    if (!instance) return reply
    return createApiResponse(instance)
  })

  app.post('/api/mcp/instances/:instanceId/test', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { instanceId } = request.params as { instanceId: string }
    if (!(await loadManageable(actorContext, instanceId, reply))) return reply
    try {
      const instance = await testInstance(
        prisma,
        actorContext.tenant.organizationId,
        instanceId,
      )
      return createApiResponse(instance)
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  // ─── Instance lifecycle (refresh / healthcheck) ─────────────────────────
  app.post('/api/mcp/instances/:instanceId/refresh', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { instanceId } = request.params as { instanceId: string }
    if (!(await loadManageable(actorContext, instanceId, reply))) return reply
    try {
      const instance = await refreshInstance(
        prisma,
        actorContext.tenant.organizationId,
        instanceId,
      )
      return createApiResponse(instance)
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  // Healthcheck is read-only and surfaces no secret material; any actor that
  // can already manage the instance scope may probe it.
  app.post('/api/mcp/instances/:instanceId/healthcheck', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { instanceId } = request.params as { instanceId: string }
    if (!(await loadManageable(actorContext, instanceId, reply))) return reply
    try {
      const result = await healthcheckInstance(
        prisma,
        actorContext.tenant.organizationId,
        instanceId,
      )
      return createApiResponse(result)
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  app.delete('/api/mcp/instances/:instanceId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { instanceId } = request.params as { instanceId: string }
    if (!(await loadManageable(actorContext, instanceId, reply))) return reply
    const deleted = await deleteInstance(
      prisma,
      actorContext.tenant.organizationId,
      instanceId,
    )
    if (!deleted) {
      sendApiError(reply, 404, MCP_INSTANCE_ERROR_CODES.NOT_FOUND, 'Instance not found')
      return reply
    }
    return reply.code(204).send()
  })
}
