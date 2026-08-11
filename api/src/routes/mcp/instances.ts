import {
  canManageInstanceScope,
  createInstance,
  deleteInstance,
  getInstance,
  healthcheckInstance,
  isOwnerRole,
  isManagedIntegrationCatalogEntry,
  isManagedIntegrationInstance,
  listInstances,
  listInstancesVisibleToUser,
  MCP_INSTANCE_ERROR_CODES,
  refreshInstance,
  resolveMcpUserAccess,
  storeInstanceSecret,
  testInstance,
  type McpInstanceRow,
  type McpUserAccess,
} from '@nessie/mcp-manage'
import { McpServerScopeTypeSchema, type AuthorizedActionContext } from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'

import { JsonRecordSchema, sendMcpError, type McpSubRegistrarContext } from './shared.js'

/**
 * Instances sub-registrar (plan §6,
 * `docs/plans/2026-05-30-mcp-store-publishing-approval.md`).
 *
 * Owns CRUD + lifecycle (`test`, `refresh`, `healthcheck`) on
 * `McpServerInstance`. Scope rules (shared with the worker's
 * personal-assistant connector tools via `@nessie/mcp-manage`):
 *
 * - `owner` role manages installs at any scope and sees everything;
 * - `admin` role manages the shared scopes (organization/project/team/channel)
 *   — "make this connector available to the whole team/org" — plus their own
 *   user scope;
 * - everyone else installs and manages connectors only at their own `user`
 *   scope, but can SEE shared-scope installs they can reach (org-wide plus
 *   the teams/channels/projects they belong to).
 */

const CreateInstanceBodySchema = z.object({
  catalogEntryId: z.string().uuid(),
  scopeType: McpServerScopeTypeSchema,
  scopeId: z.string().uuid(),
  transportConfig: JsonRecordSchema.optional(),
}).strict()

const SetSecretBodySchema = z.object({
  secret: z.string().trim().min(1).max(8192),
  shared: z.boolean().optional(),
}).strict()

const publicInstance = <T extends { credentialRef: string | null }>(
  instance: T,
): Omit<T, 'credentialRef'> => {
  const safe = { ...instance } as Record<string, unknown>
  delete safe.credentialRef
  return safe as Omit<T, 'credentialRef'>
}

/**
 * How many of each instance's projected tools are still awaiting owner review.
 *
 * Counted only over instance ids the caller was already entitled to see — the
 * list above resolves entitlement, this just annotates it. Without this the
 * Connectors page cannot tell anyone that a freshly installed connector has
 * tools nobody has approved yet, and the review surface has no doorway.
 */
const countPendingToolsByInstance = async (
  prisma: PrismaClient,
  organizationId: string,
  instanceIds: string[],
): Promise<Map<string, number>> => {
  if (instanceIds.length === 0) return new Map()
  const grouped = await prisma.toolRegistryEntry.groupBy({
    _count: { _all: true },
    by: ['mcpInstanceId'],
    where: {
      handlerKind: 'mcp',
      mcpInstanceId: { in: instanceIds },
      organizationId,
      status: 'pending_review',
    },
  })
  return new Map(
    grouped
      .filter((row): row is typeof row & { mcpInstanceId: string } =>
        row.mcpInstanceId !== null)
      .map((row) => [row.mcpInstanceId, row._count._all]),
  )
}

const FORBIDDEN_SCOPE = {
  code: 'MCP_INSTANCE_FORBIDDEN',
  message: 'You do not have permission to manage connectors at this scope',
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

  const accessFor = (actorContext: AuthorizedActionContext): Promise<McpUserAccess> =>
    resolveMcpUserAccess(
      prisma,
      actorContext.tenant.organizationId,
      actorContext.actor.actorId,
    )

  const canManage = async (
    actorContext: AuthorizedActionContext,
    scopeType: string,
    scopeId: string,
  ): Promise<boolean> => {
    if (isOwnerRole(actorContext)) return true
    const access = await accessFor(actorContext)
    return canManageInstanceScope(
      access,
      actorContext.actor.actorId,
      scopeType,
      scopeId,
    )
  }

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
    if (!(await canManage(actorContext, instance.scopeType, instance.scopeId))) {
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
    const scopeType = scopeTypeParsed?.success ? scopeTypeParsed.data : undefined

    // Owners see everything; everyone else sees their own user-scope installs
    // plus the shared-scope installs they can reach.
    const instances = isOwnerRole(actorContext)
      ? await listInstances(prisma, actorContext.tenant.organizationId, {
          scopeType,
          scopeId: query.scopeId,
        })
      : (
          await listInstancesVisibleToUser(
            prisma,
            actorContext.tenant.organizationId,
            actorContext.actor.actorId,
          )
        ).filter(
          (instance) =>
            (!scopeType || instance.scopeType === scopeType)
            && (!query.scopeId || instance.scopeId === query.scopeId),
        )
    const pendingByInstance = await countPendingToolsByInstance(
      prisma,
      actorContext.tenant.organizationId,
      instances.map((instance) => instance.id),
    )
    return createApiResponse(
      instances.map((instance) => ({
        ...publicInstance(instance),
        pendingToolCount: pendingByInstance.get(instance.id) ?? 0,
      })),
    )
  })

  app.post('/api/mcp/instances', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(CreateInstanceBodySchema, request.body, reply)
    if (!body) return reply
    if (!(await canManage(actorContext, body.scopeType, body.scopeId))) {
      return denyScope(reply)
    }
    if (await isManagedIntegrationCatalogEntry(prisma, body.catalogEntryId)) {
      sendApiError(
        reply,
        409,
        MCP_INSTANCE_ERROR_CODES.MANAGED_BY_INTEGRATION,
        'This first-party connector is provisioned from Integrations and uses Nessie SSO.',
      )
      return reply
    }

    try {
      const instance = await createInstance(prisma, actorContext, body)
      return reply.code(201).send(createApiResponse(publicInstance(instance)))
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/mcp/instances/:instanceId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

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
    // Reading is allowed for anyone who can see the instance (shared scopes
    // are meant to be discovered); managing still requires scope rights.
    if (!(await canManage(actorContext, instance.scopeType, instance.scopeId))) {
      const visible = await listInstancesVisibleToUser(
        prisma,
        actorContext.tenant.organizationId,
        actorContext.actor.actorId,
      )
      if (!visible.some((row) => row.id === instance.id)) {
        return denyScope(reply)
      }
    }
    return createApiResponse(publicInstance(instance))
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
        { secretResolver: ctx.secretResolver, probeUserId: actorContext.actor.actorId },
      )
      return createApiResponse(publicInstance(instance))
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
        { secretResolver: ctx.secretResolver, probeUserId: actorContext.actor.actorId },
      )
      return createApiResponse(publicInstance(instance))
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
        { secretResolver: ctx.secretResolver, probeUserId: actorContext.actor.actorId },
      )
      return createApiResponse(result)
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  // Store a user-provided credential for an instance (encrypted at rest).
  // Open to anyone who can SEE the instance: their own instances take the
  // secret as the connection credential, shared instances get a per-user
  // override unless the caller manages the scope and asks for shared=true.
  // Mirrors the personal assistant's connector_set_secret tool exactly
  // (same @nessie/mcp-manage implementation).
  app.post('/api/mcp/instances/:instanceId/secret', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(SetSecretBodySchema, request.body, reply)
    if (!body) return reply

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
    if (
      await isManagedIntegrationInstance(
        prisma,
        actorContext.tenant.organizationId,
        instance.id,
      )
    ) {
      sendApiError(
        reply,
        409,
        'INTEGRATION_MANAGED_CREDENTIAL',
        'This first-party connector uses signed Nessie SSO identity and its '
        + 'dedicated app API key; personal credentials are not accepted.',
      )
      return reply
    }
    const access = await accessFor(actorContext)
    const manageable =
      isOwnerRole(actorContext)
      || canManageInstanceScope(
        access,
        actorContext.actor.actorId,
        instance.scopeType,
        instance.scopeId,
      )
    if (!manageable) {
      const visible = await listInstancesVisibleToUser(
        prisma,
        actorContext.tenant.organizationId,
        actorContext.actor.actorId,
      )
      if (!visible.some((row) => row.id === instance.id)) {
        return denyScope(reply)
      }
    }

    const result = await storeInstanceSecret(prisma, ctx.mcpSecretStore, {
      instance,
      userId: actorContext.actor.actorId,
      access: isOwnerRole(actorContext) ? { role: 'owner' } : access,
      secret: body.secret,
      shared: body.shared,
    })
    return createApiResponse({ placement: result.placement })
  })

  app.delete('/api/mcp/instances/:instanceId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { instanceId } = request.params as { instanceId: string }
    if (!(await loadManageable(actorContext, instanceId, reply))) return reply
    try {
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
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })
}
