import type { PrismaClient } from '@prisma/client'
import {
  McpCatalogAuthMethodSchema,
  McpCatalogProtocolSchema,
  McpCatalogStatusSchema,
  McpCredentialPrincipalTypeSchema,
  McpServerAuthConfigSchema,
  McpServerScopeTypeSchema,
  ToolGrantStateSchema,
  ToolRegistryEntryStatusSchema,
  ToolRegistrySourceSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  createCatalogEntry,
  deleteCatalogEntry,
  getCatalogEntry,
  listCatalogEntries,
  McpCatalogError,
  MCP_CATALOG_ERROR_CODES,
  updateCatalogEntry,
} from '../services/mcp-catalog.js'
import {
  createInstance,
  deleteInstance,
  getInstance,
  listInstances,
  McpInstanceError,
  MCP_INSTANCE_ERROR_CODES,
  testInstance,
} from '../services/mcp-instances.js'
import {
  deleteOverride,
  listOverrides,
  McpCredentialError,
  MCP_CREDENTIAL_ERROR_CODES,
  upsertOverride,
} from '../services/mcp-credentials.js'
import {
  createGrant,
  deleteGrant,
  listToolRegistry,
  ToolGrantError,
  TOOL_GRANT_ERROR_CODES,
} from '../services/tool-grants.js'

/**
 * Owner-only HTTP surface for the MCP universal connector (plan §6, spec
 * `docs/external-tool-integration.md` §2 and `docs/tool-registry-spec.md` §3.1).
 *
 * Wires the five Slice-C services (catalog, instance, credential override, tool
 * grant, tool registry listing) into Fastify routes. Body schemas live here
 * because the cross-package contracts file does not yet own MCP write payloads.
 */

export type McpRouteHelpers = {
  prisma: PrismaClient
  requireActorContext: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => AuthorizedActionContext | null
  requireOwner: (actorContext: AuthorizedActionContext, reply: FastifyReply) => boolean
}

const JsonRecordSchema = z.record(z.string(), z.unknown())

const CreateCatalogEntryBodySchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  protocol: McpCatalogProtocolSchema,
  authMethod: McpCatalogAuthMethodSchema,
  authConfig: McpServerAuthConfigSchema,
  defaultTransportConfig: JsonRecordSchema.optional(),
  iconUrl: z.string().url().nullable().optional(),
  vendor: z.string().nullable().optional(),
  sourceUrl: z.string().url().nullable().optional(),
  signature: z.string().nullable().optional(),
  organizationId: z.string().uuid().nullable().optional(),
})

const UpdateCatalogEntryBodySchema = z.object({
  label: z.string().min(1).optional(),
  description: z.string().optional(),
  protocol: McpCatalogProtocolSchema.optional(),
  authMethod: McpCatalogAuthMethodSchema.optional(),
  authConfig: McpServerAuthConfigSchema.optional(),
  defaultTransportConfig: JsonRecordSchema.optional(),
  iconUrl: z.string().url().nullable().optional(),
  vendor: z.string().nullable().optional(),
  sourceUrl: z.string().url().nullable().optional(),
  signature: z.string().nullable().optional(),
  status: McpCatalogStatusSchema.optional(),
})

const CreateInstanceBodySchema = z.object({
  catalogEntryId: z.string().uuid(),
  scopeType: McpServerScopeTypeSchema,
  scopeId: z.string().uuid(),
  credentialRef: z.string().nullable().optional(),
  transportConfig: JsonRecordSchema.optional(),
})

const UpsertOverrideBodySchema = z.object({
  principalType: McpCredentialPrincipalTypeSchema,
  principalId: z.string().uuid(),
  credentialRef: z.string().min(1),
})

const CreateGrantBodySchema = z
  .object({
    toolRegistryEntryId: z.string().uuid(),
    state: ToolGrantStateSchema.optional(),
    config: JsonRecordSchema.optional(),
    roleId: z.string().uuid().nullable().optional(),
    agentId: z.string().uuid().nullable().optional(),
  })
  .refine(
    (value) => Boolean(value.roleId) !== Boolean(value.agentId),
    {
      message: 'Provide exactly one of roleId or agentId',
      path: ['roleId'],
    },
  )

const sendMcpError = (reply: FastifyReply, error: unknown): boolean => {
  if (error instanceof McpCatalogError) {
    const status =
      error.code === MCP_CATALOG_ERROR_CODES.NOT_FOUND
        ? 404
        : error.code === MCP_CATALOG_ERROR_CODES.DUPLICATE_NAME
          ? 409
          : 400
    sendApiError(reply, status, error.code, error.message)
    return true
  }
  if (error instanceof McpInstanceError) {
    const status =
      error.code === MCP_INSTANCE_ERROR_CODES.NOT_FOUND
        || error.code === MCP_INSTANCE_ERROR_CODES.CATALOG_ENTRY_NOT_FOUND
        ? 404
        : error.code === MCP_INSTANCE_ERROR_CODES.DUPLICATE_SCOPE
          ? 409
          : error.code === MCP_INSTANCE_ERROR_CODES.PROBE_FAILED
            ? 502
            : 400
    sendApiError(reply, status, error.code, error.message)
    return true
  }
  if (error instanceof McpCredentialError) {
    const status =
      error.code === MCP_CREDENTIAL_ERROR_CODES.INSTANCE_NOT_FOUND
        || error.code === MCP_CREDENTIAL_ERROR_CODES.OVERRIDE_NOT_FOUND
        ? 404
        : 400
    sendApiError(reply, status, error.code, error.message)
    return true
  }
  if (error instanceof ToolGrantError) {
    const status =
      error.code === TOOL_GRANT_ERROR_CODES.TOOL_NOT_FOUND
        || error.code === TOOL_GRANT_ERROR_CODES.GRANT_NOT_FOUND
        ? 404
        : 400
    sendApiError(reply, status, error.code, error.message)
    return true
  }
  return false
}

export const registerMcpRoutes = (
  app: FastifyInstance,
  helpers: McpRouteHelpers,
): void => {
  const { prisma, requireActorContext, requireOwner } = helpers

  // ─── Catalog ─────────────────────────────────────────────────────────────
  app.get('/api/mcp/catalog', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as { status?: string }
    const statusParsed = query.status
      ? McpCatalogStatusSchema.safeParse(query.status)
      : null
    if (statusParsed && !statusParsed.success) {
      sendApiError(reply, 400, 'VALIDATION_ERROR', 'Invalid status filter', 'status')
      return reply
    }

    const entries = await listCatalogEntries(
      prisma,
      actorContext.tenant.organizationId,
      { status: statusParsed?.success ? statusParsed.data : undefined },
    )
    return createApiResponse(entries)
  })

  app.post('/api/mcp/catalog', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(CreateCatalogEntryBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const entry = await createCatalogEntry(prisma, actorContext, body)
      return reply.code(201).send(createApiResponse(entry))
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/mcp/catalog/:catalogEntryId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { catalogEntryId } = request.params as { catalogEntryId: string }
    const entry = await getCatalogEntry(
      prisma,
      actorContext.tenant.organizationId,
      catalogEntryId,
    )
    if (!entry) {
      sendApiError(reply, 404, MCP_CATALOG_ERROR_CODES.NOT_FOUND, 'Catalog entry not found')
      return reply
    }
    return createApiResponse(entry)
  })

  app.patch('/api/mcp/catalog/:catalogEntryId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { catalogEntryId } = request.params as { catalogEntryId: string }
    const body = parseInput(UpdateCatalogEntryBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const entry = await updateCatalogEntry(
        prisma,
        actorContext.tenant.organizationId,
        catalogEntryId,
        body,
      )
      if (!entry) {
        sendApiError(reply, 404, MCP_CATALOG_ERROR_CODES.NOT_FOUND, 'Catalog entry not found')
        return reply
      }
      return createApiResponse(entry)
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  app.delete('/api/mcp/catalog/:catalogEntryId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { catalogEntryId } = request.params as { catalogEntryId: string }
    const deleted = await deleteCatalogEntry(
      prisma,
      actorContext.tenant.organizationId,
      catalogEntryId,
    )
    if (!deleted) {
      sendApiError(reply, 404, MCP_CATALOG_ERROR_CODES.NOT_FOUND, 'Catalog entry not found')
      return reply
    }
    return reply.code(204).send()
  })

  // ─── Instances ──────────────────────────────────────────────────────────
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

  // ─── Credential overrides ───────────────────────────────────────────────
  app.get('/api/mcp/instances/:instanceId/credentials', async (request, reply) => {
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
    const overrides = await listOverrides(prisma, instanceId)
    return createApiResponse(overrides)
  })

  app.put('/api/mcp/instances/:instanceId/credentials', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { instanceId } = request.params as { instanceId: string }
    const body = parseInput(UpsertOverrideBodySchema, request.body, reply)
    if (!body) return reply

    const instance = await getInstance(
      prisma,
      actorContext.tenant.organizationId,
      instanceId,
    )
    if (!instance) {
      sendApiError(reply, 404, MCP_INSTANCE_ERROR_CODES.NOT_FOUND, 'Instance not found')
      return reply
    }

    try {
      const override = await upsertOverride(prisma, {
        instanceId,
        principalType: body.principalType,
        principalId: body.principalId,
        credentialRef: body.credentialRef,
      })
      return createApiResponse(override)
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  app.delete(
    '/api/mcp/instances/:instanceId/credentials/:principalType/:principalId',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply
      if (!requireOwner(actorContext, reply)) return reply

      const params = request.params as {
        instanceId: string
        principalType: string
        principalId: string
      }

      const instance = await getInstance(
        prisma,
        actorContext.tenant.organizationId,
        params.instanceId,
      )
      if (!instance) {
        sendApiError(reply, 404, MCP_INSTANCE_ERROR_CODES.NOT_FOUND, 'Instance not found')
        return reply
      }

      const principalType = McpCredentialPrincipalTypeSchema.safeParse(params.principalType)
      if (!principalType.success) {
        sendApiError(
          reply,
          400,
          'VALIDATION_ERROR',
          'Invalid principalType',
          'principalType',
        )
        return reply
      }

      const deleted = await deleteOverride(prisma, {
        instanceId: params.instanceId,
        principalType: principalType.data,
        principalId: params.principalId,
      })
      if (!deleted) {
        sendApiError(
          reply,
          404,
          MCP_CREDENTIAL_ERROR_CODES.OVERRIDE_NOT_FOUND,
          'Override not found',
        )
        return reply
      }
      return reply.code(204).send()
    },
  )

  // ─── Tool registry + grants ─────────────────────────────────────────────
  app.get('/api/mcp/tools', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as {
      status?: string
      source?: string
      scopeKey?: string
    }
    const statusParsed = query.status
      ? ToolRegistryEntryStatusSchema.safeParse(query.status)
      : null
    if (statusParsed && !statusParsed.success) {
      sendApiError(reply, 400, 'VALIDATION_ERROR', 'Invalid status filter', 'status')
      return reply
    }
    const sourceParsed = query.source
      ? ToolRegistrySourceSchema.safeParse(query.source)
      : null
    if (sourceParsed && !sourceParsed.success) {
      sendApiError(reply, 400, 'VALIDATION_ERROR', 'Invalid source filter', 'source')
      return reply
    }

    const tools = await listToolRegistry(prisma, actorContext.tenant.organizationId, {
      status: statusParsed?.success ? statusParsed.data : undefined,
      source: sourceParsed?.success ? sourceParsed.data : undefined,
      scopeKey: query.scopeKey,
    })
    return createApiResponse(tools)
  })

  app.post('/api/mcp/tools/:toolRegistryEntryId/grants', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { toolRegistryEntryId } = request.params as { toolRegistryEntryId: string }
    const body = parseInput(CreateGrantBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const grant = await createGrant(prisma, {
        toolRegistryEntryId,
        organizationId: actorContext.tenant.organizationId,
        state: body.state,
        config: body.config,
        roleId: body.roleId,
        agentId: body.agentId,
      })
      return reply.code(201).send(createApiResponse(grant))
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  app.delete(
    '/api/mcp/tools/:toolRegistryEntryId/grants/:grantId',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply
      if (!requireOwner(actorContext, reply)) return reply

      const { toolRegistryEntryId, grantId } = request.params as {
        toolRegistryEntryId: string
        grantId: string
      }
      const deleted = await deleteGrant(
        prisma,
        actorContext.tenant.organizationId,
        toolRegistryEntryId,
        grantId,
      )
      if (!deleted) {
        sendApiError(
          reply,
          404,
          TOOL_GRANT_ERROR_CODES.GRANT_NOT_FOUND,
          'Grant not found',
        )
        return reply
      }
      return reply.code(204).send()
    },
  )
}
