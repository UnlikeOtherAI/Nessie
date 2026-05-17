import { McpServerScopeTypeSchema } from '@nessie/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import {
  createInstance,
  deleteInstance,
  getInstance,
  healthcheckInstance,
  listInstances,
  MCP_INSTANCE_ERROR_CODES,
  refreshInstance,
  testInstance,
} from '../../services/mcp-instances.js'

import { JsonRecordSchema, sendMcpError, type McpSubRegistrarContext } from './shared.js'

/**
 * Instances sub-registrar (plan §6).
 *
 * Owns CRUD + lifecycle (`test`, `refresh`, `healthcheck`) on
 * `McpServerInstance`. Credential-override routes live in `./credentials.ts`
 * because the principal model + `SecretStore` concerns are distinct enough to
 * justify a separate file.
 */

const CreateInstanceBodySchema = z.object({
  catalogEntryId: z.string().uuid(),
  scopeType: McpServerScopeTypeSchema,
  scopeId: z.string().uuid(),
  credentialRef: z.string().nullable().optional(),
  transportConfig: JsonRecordSchema.optional(),
})

export const registerMcpInstanceRoutes = (
  app: FastifyInstance,
  ctx: McpSubRegistrarContext,
): void => {
  const { prisma, requireActorContext, requireOwner } = ctx

  app.get('/api/mcp/instances', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as { scopeType?: string; scopeId?: string }
    const scopeTypeParsed = query.scopeType
      ? McpServerScopeTypeSchema.safeParse(query.scopeType)
      : null
    if (scopeTypeParsed && !scopeTypeParsed.success) {
      sendApiError(reply, 400, 'VALIDATION_ERROR', 'Invalid scopeType filter', 'scopeType')
      return reply
    }

    const instances = await listInstances(prisma, actorContext.tenant.organizationId, {
      scopeType: scopeTypeParsed?.success ? scopeTypeParsed.data : undefined,
      scopeId: query.scopeId,
    })
    return createApiResponse(instances)
  })

  app.post('/api/mcp/instances', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(CreateInstanceBodySchema, request.body, reply)
    if (!body) return reply

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
    if (!requireOwner(actorContext, reply)) return reply

    const { instanceId } = request.params as { instanceId: string }
    const instance = await getInstance(
      prisma,
      actorContext.tenant.organizationId,
      instanceId,
    )
    if (!instance) {
      sendApiError(reply, 404, MCP_INSTANCE_ERROR_CODES.NOT_FOUND, 'Instance not found')
      return reply
    }
    return createApiResponse(instance)
  })

  app.post('/api/mcp/instances/:instanceId/test', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { instanceId } = request.params as { instanceId: string }
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
  // Per plan §6:
  //   refresh — re-runs probe + registry projection; tolerant of probe
  //     failure (returns the up-to-date instance row with `error`
  //     lifecycleState instead of 502).
  //   healthcheck — synchronous probe with no DB writes; returns
  //     `{healthy, latencyMs, lastError?}` for admin polling.
  app.post('/api/mcp/instances/:instanceId/refresh', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { instanceId } = request.params as { instanceId: string }
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

  // Healthcheck is intentionally `requireActorContext` only — any
  // authenticated user who can already see this instance can run a probe.
  // Owner-gating is overkill for a read-only call that mutates nothing and
  // surfaces no secret material.
  app.post('/api/mcp/instances/:instanceId/healthcheck', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { instanceId } = request.params as { instanceId: string }
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
    if (!requireOwner(actorContext, reply)) return reply

    const { instanceId } = request.params as { instanceId: string }
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
