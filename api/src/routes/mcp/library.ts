import {
  approveSubmission,
  createCatalogEntry,
  discoverMcpEndpoint,
  isOwnerRole,
  publishCatalogEntry,
  searchMcpLibrary,
  submitForReview,
  type CreateCatalogEntryInput,
} from '@nessie/mcp-manage'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'

import { sendMcpError, type McpSubRegistrarContext } from './shared.js'

/**
 * Library + discovery sub-registrar.
 *
 * `GET /api/mcp/library` searches the public MCP server library (curated list
 * + the official registry at registry.modelcontextprotocol.io), remote
 * HTTP/SSE servers only. `POST /api/mcp/library/import` turns a library entry
 * (or a discovery proposal) into an org catalog entry ready to install.
 * `POST /api/mcp/discover` probes a pasted link for an MCP endpoint and
 * reports transport + auth requirements — the "I only have a URL" path for
 * non-technical users and the personal assistant.
 *
 * All three are open to any signed-in member: they create nothing outside the
 * caller's own (private) catalog space unless the caller is an owner sharing
 * to the org store.
 */

const LibraryQuerySchema = z.object({
  search: z.string().max(200).optional(),
  curatedOnly: z.enum(['true', 'false']).optional(),
})

const ImportBodySchema = z.object({
  entry: z.object({
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9-_]*$/, 'name must be a lowercase slug'),
    label: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    url: z.string().url(),
    transport: z.enum(['http', 'sse']),
    authMethod: z.enum(['none', 'bearer', 'api_key']),
    vendor: z.string().max(200).nullable().optional(),
    sourceUrl: z.string().url().nullable().optional(),
    apiKeyHeaderName: z.string().min(1).max(100).optional(),
    apiKeyValuePrefix: z.string().max(100).optional(),
  }),
  /** Self-publish the (private) entry so it is immediately installable. */
  publish: z.boolean().optional(),
  /** Owner only: publish into the org-wide public store. */
  shareToOrg: z.boolean().optional(),
})

const DiscoverBodySchema = z.object({
  url: z.string().min(3).max(2000),
})

export const registerMcpLibraryRoutes = (
  app: FastifyInstance,
  ctx: McpSubRegistrarContext,
): void => {
  const { prisma, requireActorContext } = ctx

  app.get('/api/mcp/library', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const query = parseInput(LibraryQuerySchema, request.query ?? {}, reply)
    if (!query) return reply

    const result = await searchMcpLibrary(query.search ?? '', {
      curatedOnly: query.curatedOnly === 'true',
    })
    return createApiResponse(result)
  })

  app.post('/api/mcp/library/import', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(ImportBodySchema, request.body, reply)
    if (!body) return reply

    if (body.shareToOrg && !isOwnerRole(actorContext)) {
      sendApiError(
        reply,
        403,
        'FORBIDDEN',
        'Only owners can share a library entry to the organization store',
      )
      return reply
    }

    const { entry } = body
    const input: CreateCatalogEntryInput = {
      name: entry.name,
      label: entry.label,
      description: entry.description ?? '',
      protocol: entry.transport,
      authMethod: entry.authMethod,
      authConfig:
        entry.authMethod === 'api_key'
          ? {
              method: 'api_key',
              headerName: entry.apiKeyHeaderName ?? 'Authorization',
              valuePrefix: entry.apiKeyValuePrefix ?? '',
            }
          : { method: entry.authMethod },
      defaultTransportConfig: { transport: entry.transport, url: entry.url },
      vendor: entry.vendor ?? null,
      sourceUrl: entry.sourceUrl ?? null,
    }

    try {
      const created = await createCatalogEntry(prisma, actorContext, input)
      let published = created
      if (body.shareToOrg) {
        await submitForReview(prisma, actorContext, created.id)
        published = (await approveSubmission(prisma, actorContext, created.id)) ?? created
      } else if (body.publish ?? true) {
        published = (await publishCatalogEntry(prisma, actorContext, created.id)) ?? created
      }
      return reply.code(201).send(createApiResponse(published))
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/mcp/discover', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(DiscoverBodySchema, request.body, reply)
    if (!body) return reply

    const result = await discoverMcpEndpoint(body.url)
    return createApiResponse(result)
  })
}
