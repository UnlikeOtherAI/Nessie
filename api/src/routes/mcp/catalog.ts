import {
  McpCatalogAuthMethodSchema,
  McpCatalogProtocolSchema,
  McpCatalogStatusSchema,
  McpServerAuthConfigSchema,
} from '@nessie/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import {
  createCatalogEntry,
  deleteCatalogEntry,
  deprecateCatalogEntry,
  getCatalogEntry,
  listCatalogEntries,
  MCP_CATALOG_ERROR_CODES,
  publishCatalogEntry,
  updateCatalogEntry,
} from '../../services/mcp-catalog.js'

import { JsonRecordSchema, sendMcpError, type McpSubRegistrarContext } from './shared.js'

/**
 * Catalog sub-registrar (plan §6, `docs/external-tool-integration.md` §2).
 *
 * Owns CRUD plus the lifecycle transitions (`publish`, `deprecate`) on
 * `McpCatalogEntry`. Body schemas live here because the cross-package
 * contracts file does not yet own MCP write payloads.
 */

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

export const registerMcpCatalogRoutes = (
  app: FastifyInstance,
  ctx: McpSubRegistrarContext,
): void => {
  const { prisma, requireActorContext, requireOwner } = ctx

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
}
