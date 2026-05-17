import type { PrismaClient } from '@prisma/client'
import {
  ToolGrantStateSchema,
  ToolRegistryEntryStatusSchema,
  ToolRegistrySourceSchema,
} from '@nessie/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import {
  createGrant,
  deleteGrant,
  listToolRegistry,
  TOOL_GRANT_ERROR_CODES,
  type ToolGrantRow,
  type ToolRegistryRow,
} from '../../services/tool-grants.js'
import { fromPrismaToolGrantSource } from '../../services/tool-enum-mapping.js'

import { JsonRecordSchema, sendMcpError, type McpSubRegistrarContext } from './shared.js'

/**
 * Tool-registry + grants sub-registrar (plan §6, `docs/tool-registry-spec.md` §3.1).
 *
 * The tool listing and grant CRUD are intentionally co-located:
 * `attachGrantsToRegistryEntries` joins the two on every list response so the
 * admin matrix has grant ids on first paint (task #25).
 */

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

export const registerMcpToolsRoutes = (
  app: FastifyInstance,
  ctx: McpSubRegistrarContext,
): void => {
  const { prisma, requireActorContext, requireOwner } = ctx

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
}
