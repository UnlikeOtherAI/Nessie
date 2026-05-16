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
  deprecateCatalogEntry,
  getCatalogEntry,
  listCatalogEntries,
  McpCatalogError,
  MCP_CATALOG_ERROR_CODES,
  publishCatalogEntry,
  updateCatalogEntry,
} from '../services/mcp-catalog.js'
import {
  createInstance,
  deleteInstance,
  getInstance,
  healthcheckInstance,
  listInstances,
  McpInstanceError,
  MCP_INSTANCE_ERROR_CODES,
  refreshInstance,
  testInstance,
} from '../services/mcp-instances.js'
import {
  completeOAuth,
  inMemorySecretStoreStub,
  McpOAuthError,
  MCP_OAUTH_ERROR_CODES,
  startOAuth,
  type SecretStore,
} from '../services/mcp-oauth.js'
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
  type ToolGrantRow,
  type ToolRegistryRow,
} from '../services/tool-grants.js'
import { fromPrismaToolGrantSource } from '../services/tool-enum-mapping.js'

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
  /**
   * Override the OAuth secret store for tests. Production should always wire
   * a KMS-backed implementation (`SecretStore.put` must persist plaintext
   * outside process memory). The default `inMemorySecretStoreStub` only ships
   * a placeholder ref and is NOT safe for real credentials.
   */
  oauthSecretStore?: SecretStore
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

// `toolRegistryEntryId` is intentionally NOT in the body — it comes from the
// route param (`POST /api/mcp/tools/:toolRegistryEntryId/grants`). Including
// it in the body schema as well caused the admin facade to 400 (E2E BUG-1)
// because it strips the id into the URL and never sends it in the JSON body.
//
// Exported for regression coverage (task #21): principal IDs (`roleId` /
// `agentId`) MUST be validated as UUIDs at the route boundary so malformed
// strings cannot reach Prisma — Prisma's own UUID coercion only fails at
// query time, after the row is already partially constructed.
export const CreateGrantBodySchema = z
  .object({
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

/**
 * Tool registry entry with its associated grants attached. The admin
 * `AgentGrantMatrix` (task #25) needs grant IDs alongside the tool list on
 * initial render so cross-session unchecks can DELETE without first POSTing
 * to capture the id. Grants are scoped indirectly: `listToolRegistry`
 * already filters tools to the caller's org (or `organizationId: null`
 * globals), so any grant whose `toolId` references a row in that list is
 * implicitly in-scope. We do NOT need an explicit org clause on `toolGrant`
 * itself — the table has no `organizationId` column.
 */
export type ToolRegistryEntryWithGrants = ToolRegistryRow & {
  grants: ToolGrantRow[]
}

export const attachGrantsToRegistryEntries = async (
  prisma: PrismaClient,
  entries: ToolRegistryRow[],
): Promise<ToolRegistryEntryWithGrants[]> => {
  if (entries.length === 0) return []
  const toolIds = entries.map((entry) => entry.id)
  const grants = await prisma.toolGrant.findMany({
    where: { toolId: { in: toolIds } },
    orderBy: { createdAt: 'asc' },
  })
  const grantsByToolId = new Map<string, ToolGrantRow[]>()
  for (const grant of grants) {
    const mapped: ToolGrantRow = {
      id: grant.id,
      toolId: grant.toolId,
      state: grant.state as ToolGrantRow['state'],
      config: grant.config,
      source: fromPrismaToolGrantSource(grant.source),
      roleId: grant.roleId,
      agentId: grant.agentId,
      createdAt: grant.createdAt,
      updatedAt: grant.updatedAt,
    }
    const bucket = grantsByToolId.get(grant.toolId)
    if (bucket) {
      bucket.push(mapped)
    } else {
      grantsByToolId.set(grant.toolId, [mapped])
    }
  }
  return entries.map((entry) => ({
    ...entry,
    grants: grantsByToolId.get(entry.id) ?? [],
  }))
}

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
  if (error instanceof McpOAuthError) {
    const status =
      error.code === MCP_OAUTH_ERROR_CODES.INSTANCE_NOT_FOUND
        || error.code === MCP_OAUTH_ERROR_CODES.CATALOG_ENTRY_NOT_FOUND
        ? 404
        : error.code === MCP_OAUTH_ERROR_CODES.STATE_INVALID
            || error.code === MCP_OAUTH_ERROR_CODES.STATE_EXPIRED
          ? 400
          : error.code === MCP_OAUTH_ERROR_CODES.TOKEN_EXCHANGE_FAILED
              || error.code === MCP_OAUTH_ERROR_CODES.TOKEN_RESPONSE_INVALID
            ? 502
            : 400
    sendApiError(reply, status, error.code, error.message)
    return true
  }
  return false
}

/**
 * Build the OAuth callback URL the provider should redirect to. We resolve
 * the protocol/host from the inbound request rather than hardcoding so the
 * same code works behind a reverse proxy or on localhost dev. The path is
 * fixed at `/api/mcp/oauth/callback` per task #20 spec.
 */
const buildOAuthCallbackUrl = (request: FastifyRequest): string => {
  const protoHeader = request.headers['x-forwarded-proto']
  const proto = typeof protoHeader === 'string'
    ? protoHeader.split(',')[0]?.trim() ?? request.protocol
    : request.protocol
  const hostHeader = request.headers['x-forwarded-host'] ?? request.headers.host
  const host = typeof hostHeader === 'string' ? hostHeader.split(',')[0]?.trim() : undefined
  if (!host) {
    // Fallback to a relative-ish URL so we still surface a usable redirect
    // even when the host header is missing — most providers will reject this
    // but at least the error is visible in logs rather than silently using
    // the wrong domain.
    return '/api/mcp/oauth/callback'
  }
  return `${proto}://${host}/api/mcp/oauth/callback`
}

export const registerMcpRoutes = (
  app: FastifyInstance,
  helpers: McpRouteHelpers,
): void => {
  const { prisma, requireActorContext, requireOwner } = helpers
  const oauthSecretStore = helpers.oauthSecretStore ?? inMemorySecretStoreStub()

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

  // ─── Catalog lifecycle (publish / deprecate) ────────────────────────────
  // Per plan §6: publish promotes `draft` → `published`; deprecate marks
  // `published` → `deprecated` without breaking existing instance installs.
  app.post('/api/mcp/catalog/:catalogEntryId/publish', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { catalogEntryId } = request.params as { catalogEntryId: string }
    try {
      const entry = await publishCatalogEntry(
        prisma,
        actorContext.tenant.organizationId,
        catalogEntryId,
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

  app.post('/api/mcp/catalog/:catalogEntryId/deprecate', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { catalogEntryId } = request.params as { catalogEntryId: string }
    try {
      const entry = await deprecateCatalogEntry(
        prisma,
        actorContext.tenant.organizationId,
        catalogEntryId,
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
    const withGrants = await attachGrantsToRegistryEntries(prisma, tools)
    return createApiResponse(withGrants)
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

  // ─── OAuth handshake (plan §6) ──────────────────────────────────────────
  // `start` mints a cryptographically random state token (10-min TTL,
  // single-use) and returns the authorization URL the admin UI should send
  // the user to. The callback verifies state, exchanges the auth code for
  // tokens via the catalog entry's `tokenUrl`, persists the access token
  // through the injected `SecretStore`, and links the resulting `secret_*`
  // ref onto a per-user `McpServerCredentialOverride` row so multiple users
  // installing the same instance keep separate OAuth identities.
  app.post('/api/mcp/instances/:instanceId/oauth/start', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { instanceId } = request.params as { instanceId: string }
    try {
      const result = await startOAuth({
        prisma,
        instanceId,
        actorContext,
        callbackUrl: buildOAuthCallbackUrl(request),
      })
      return createApiResponse(result)
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/mcp/oauth/callback', async (request, reply) => {
    // Callback is open by design — the provider redirects the end-user's
    // browser here with `code` + `state`. Authn lives in the state token
    // itself (random, single-use, server-side stored). We do NOT require an
    // actor context because the user's session may have rotated between
    // `start` and the provider's redirect; the state record carries the
    // original actor id.
    const query = request.query as { code?: string; state?: string; error?: string }
    if (query.error) {
      sendApiError(
        reply,
        400,
        'MCP_OAUTH_PROVIDER_ERROR',
        `OAuth provider returned error: ${query.error}`,
      )
      return reply
    }
    if (!query.code || !query.state) {
      sendApiError(
        reply,
        400,
        'VALIDATION_ERROR',
        'OAuth callback requires both `code` and `state`',
      )
      return reply
    }
    try {
      const result = await completeOAuth({
        prisma,
        secretStore: oauthSecretStore,
        state: query.state,
        code: query.code,
        callbackUrl: buildOAuthCallbackUrl(request),
      })
      return createApiResponse(result)
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })
}
