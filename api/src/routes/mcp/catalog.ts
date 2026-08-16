import {
  McpCatalogAuthMethodSchema,
  McpCatalogProtocolSchema,
  McpCatalogStatusSchema,
  McpServerAuthConfigSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import {
  createCatalogEntry,
  deleteCatalogEntry,
  deprecateCatalogEntry,
  setCatalogEntryLocked,
  getAccessibleCatalogEntry,
  isOwnerRole,
  isSuperAdminUser,
  listCatalogEntries,
  MCP_CATALOG_ERROR_CODES,
  publishCatalogEntry,
  updateCatalogEntry,
  type CatalogView,
} from '@nessie/mcp-manage'
import {
  approveSubmission,
  rejectSubmission,
  submitForReview,
} from '@nessie/mcp-manage'

import { presentCatalogEntries, presentCatalogEntry } from './catalog-response.js'
import { JsonRecordSchema, sendMcpError, type McpSubRegistrarContext } from './shared.js'

/**
 * Catalog sub-registrar (plan §6,
 * `docs/plans/2026-05-30-mcp-store-publishing-approval.md`).
 *
 * CRUD plus the lifecycle transitions on `McpCatalogEntry`:
 * - any signed-in user creates/edits/self-publishes their own `private`
 *   connectors and submits them for the public store (`submit`);
 * - the instance super-admin (`User.superAdmin`) reviews the queue and
 *   `approve`s / `reject`s submissions, and may manage the instance-global
 *   (`organizationId: null`) entries. An org owner manages their own tenant's
 *   entries only — see `canManageEntry`.
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
})

const RejectSubmissionBodySchema = z.object({
  reason: z.string().min(1).max(2000),
})

const CatalogViewSchema = z.enum(['store', 'mine', 'queue', 'all'])

const notFound = (reply: FastifyReply): FastifyReply => {
  sendApiError(reply, 404, MCP_CATALOG_ERROR_CODES.NOT_FOUND, 'Catalog entry not found')
  return reply
}

/**
 * The store-review gate. Uses the same DB-authoritative `isSuperAdminUser` the
 * service layer uses rather than a second copy threaded through the MCP route
 * context: `User.superAdmin` is a user-row flag, never a tenant-scoped session
 * claim, so there is nothing in the request to trust.
 */
const requireCatalogSuperAdmin = async (
  prisma: McpSubRegistrarContext['prisma'],
  actorContext: AuthorizedActionContext,
  reply: FastifyReply,
): Promise<boolean> => {
  if (await isSuperAdminUser(prisma, actorContext)) return true
  sendApiError(reply, 403, 'FORBIDDEN', 'Instance super-admin access required')
  return false
}

export const registerMcpCatalogRoutes = (
  app: FastifyInstance,
  ctx: McpSubRegistrarContext,
): void => {
  const { prisma, requireActorContext } = ctx

  app.get('/api/mcp/catalog', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const query = request.query as { status?: string; view?: string }
    const viewParsed = query.view ? CatalogViewSchema.safeParse(query.view) : null
    if (viewParsed && !viewParsed.success) {
      sendApiError(reply, 400, 'VALIDATION_ERROR', 'Invalid view filter', 'view')
      return reply
    }
    const view: CatalogView = viewParsed?.success ? viewParsed.data : 'store'

    // `queue` (pending submissions) and `all` (everything) are the reviewer's
    // management views over the shared store, so they belong to whoever
    // administers this instance — `User.superAdmin` — and not to an owner of
    // one organisation among many. (`catalogTenancyWhere` still bounds the
    // rows, so this is about who reviews, not about crossing tenancy.)
    if (
      (view === 'queue' || view === 'all')
      && !(await requireCatalogSuperAdmin(prisma, actorContext, reply))
    ) {
      return reply
    }

    const statusParsed = query.status
      ? McpCatalogStatusSchema.safeParse(query.status)
      : null
    if (statusParsed && !statusParsed.success) {
      sendApiError(reply, 400, 'VALIDATION_ERROR', 'Invalid status filter', 'status')
      return reply
    }

    const entries = await listCatalogEntries(prisma, actorContext, {
      view,
      status: statusParsed?.success ? statusParsed.data : undefined,
    })
    return createApiResponse(await presentCatalogEntries(prisma, entries))
  })

  // Any signed-in user can author a connector; it starts private + draft, owned
  // by the author. Publishing it to the public store goes through `submit`.
  app.post('/api/mcp/catalog', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(CreateCatalogEntryBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const entry = await createCatalogEntry(prisma, actorContext, body)
      return reply.code(201).send(
        createApiResponse(await presentCatalogEntry(prisma, entry)),
      )
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/mcp/catalog/:catalogEntryId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { catalogEntryId } = request.params as { catalogEntryId: string }
    const entry = await getAccessibleCatalogEntry(prisma, actorContext, catalogEntryId)
    if (!entry) return notFound(reply)
    return createApiResponse(await presentCatalogEntry(prisma, entry))
  })

  app.patch('/api/mcp/catalog/:catalogEntryId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { catalogEntryId } = request.params as { catalogEntryId: string }
    const body = parseInput(UpdateCatalogEntryBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const entry = await updateCatalogEntry(prisma, actorContext, catalogEntryId, body)
      if (!entry) return notFound(reply)
      return createApiResponse(await presentCatalogEntry(prisma, entry))
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  app.delete('/api/mcp/catalog/:catalogEntryId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { catalogEntryId } = request.params as { catalogEntryId: string }
    try {
      const deleted = await deleteCatalogEntry(prisma, actorContext, catalogEntryId)
      if (!deleted) return notFound(reply)
      return reply.code(204).send()
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  // ─── Private self-publish / deprecate ───────────────────────────────────
  app.post('/api/mcp/catalog/:catalogEntryId/publish', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { catalogEntryId } = request.params as { catalogEntryId: string }
    try {
      const entry = await publishCatalogEntry(prisma, actorContext, catalogEntryId)
      if (!entry) return notFound(reply)
      return createApiResponse(await presentCatalogEntry(prisma, entry))
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  // ─── Admin lock / unlock (owner or org admin) ───────────────────────────
  app.post('/api/mcp/catalog/:catalogEntryId/lock', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { catalogEntryId } = request.params as { catalogEntryId: string }
    try {
      const entry = await setCatalogEntryLocked(prisma, actorContext, catalogEntryId, true)
      if (!entry) return notFound(reply)
      return createApiResponse(await presentCatalogEntry(prisma, entry))
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/mcp/catalog/:catalogEntryId/unlock', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { catalogEntryId } = request.params as { catalogEntryId: string }
    try {
      const entry = await setCatalogEntryLocked(prisma, actorContext, catalogEntryId, false)
      if (!entry) return notFound(reply)
      return createApiResponse(await presentCatalogEntry(prisma, entry))
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/mcp/catalog/:catalogEntryId/deprecate', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { catalogEntryId } = request.params as { catalogEntryId: string }
    try {
      const entry = await deprecateCatalogEntry(prisma, actorContext, catalogEntryId)
      if (!entry) return notFound(reply)
      return createApiResponse(await presentCatalogEntry(prisma, entry))
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  // ─── Public-store review flow ───────────────────────────────────────────
  // submit: owner of the entry asks for it to be listed publicly.
  app.post('/api/mcp/catalog/:catalogEntryId/submit', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { catalogEntryId } = request.params as { catalogEntryId: string }
    try {
      const entry = await submitForReview(prisma, actorContext, catalogEntryId)
      if (!entry) return notFound(reply)
      return createApiResponse(await presentCatalogEntry(prisma, entry))
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  // approve / reject: instance super-admin decisions on the pending queue.
  // Publishing puts a connector in front of every organisation on the
  // deployment, which is instance administration, not org administration.
  app.post('/api/mcp/catalog/:catalogEntryId/approve', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await requireCatalogSuperAdmin(prisma, actorContext, reply))) return reply

    const { catalogEntryId } = request.params as { catalogEntryId: string }
    try {
      const entry = await approveSubmission(prisma, actorContext, catalogEntryId)
      if (!entry) return notFound(reply)
      return createApiResponse(await presentCatalogEntry(prisma, entry))
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/mcp/catalog/:catalogEntryId/reject', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await requireCatalogSuperAdmin(prisma, actorContext, reply))) return reply

    const { catalogEntryId } = request.params as { catalogEntryId: string }
    const body = parseInput(RejectSubmissionBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const entry = await rejectSubmission(
        prisma,
        actorContext,
        catalogEntryId,
        body.reason,
      )
      if (!entry) return notFound(reply)
      return createApiResponse(await presentCatalogEntry(prisma, entry))
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })
}

// `isOwnerRole` is re-exported for route tests that assert the gating logic
// without standing up a full Fastify instance.
export { isOwnerRole }
