import { McpCredentialPrincipalTypeSchema } from '@nessie/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import {
  getCatalogEntry,
  isValidatedMcpApiKeyAuth,
  getInstance,
  isManagedIntegrationInstance,
  MCP_INSTANCE_ERROR_CODES,
} from '@nessie/mcp-manage'
import {
  deleteOverride,
  listOverrides,
  MCP_CREDENTIAL_ERROR_CODES,
  upsertOverride,
} from '@nessie/mcp-manage'

import { guardMcpSecretWrite } from '../auth-rate-limit.js'

import { sendMcpError, type McpSubRegistrarContext } from './shared.js'

/**
 * Credential-override sub-registrar (plan §6, `docs/external-tool-integration.md` §2).
 *
 * Owns the per-principal credential overrides hanging off an instance. Kept
 * separate from `./instances.ts` because the principal model + `SecretStore`
 * concerns are sufficiently distinct.
 */

const UpsertOverrideBodySchema = z.object({
  principalType: McpCredentialPrincipalTypeSchema,
  principalId: z.string().uuid(),
  secret: z.string().trim().min(1).max(8192),
}).strict()

const publicOverride = <T extends { credentialRef: string }>(
  override: T,
): Omit<T, 'credentialRef'> => {
  const safe = { ...override } as Record<string, unknown>
  delete safe.credentialRef
  return safe as Omit<T, 'credentialRef'>
}

export const registerMcpCredentialRoutes = (
  app: FastifyInstance,
  ctx: McpSubRegistrarContext,
): void => {
  const { prisma, requireActorContext, requireOwner, config, rateLimiter } = ctx

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
    return createApiResponse(overrides.map(publicOverride))
  })

  app.put('/api/mcp/instances/:instanceId/credentials', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply
    // Secret writes are brute-force/oracle-sensitive: cap per IP and per owner.
    if (!(await guardMcpSecretWrite(rateLimiter, config.api.rateLimit, request, reply, actorContext))) {
      return reply
    }

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
    if (
      await isManagedIntegrationInstance(
        prisma,
        actorContext.tenant.organizationId,
        instanceId,
      )
    ) {
      sendApiError(
        reply,
        409,
        'INTEGRATION_MANAGED_CREDENTIAL',
        'This first-party connector uses its dedicated app API key and signed '
        + 'SSO caller identity; it does not accept credential overrides.',
      )
      return reply
    }

    const catalogEntry = await getCatalogEntry(
      prisma,
      actorContext.tenant.organizationId,
      instance.catalogEntryId,
    )
    if (!catalogEntry) {
      sendApiError(reply, 404, MCP_INSTANCE_ERROR_CODES.CATALOG_ENTRY_NOT_FOUND, 'Catalog entry not found')
      return reply
    }
    // OAuth and other personal tokens are a delegation made by the person who
    // authenticated them. Even an owner cannot attach one to an agent, channel,
    // or another person through this low-level override route. The OAuth
    // completion flow follows the same rule by writing the signing-in user's
    // override itself. A shared credential needs a catalog contract that
    // validates both the API-key method and its header configuration.
    if (
      (body.principalType !== 'user' || body.principalId !== actorContext.actor.actorId)
      && !isValidatedMcpApiKeyAuth(catalogEntry.authMethod, catalogEntry.authConfig)
    ) {
      sendApiError(
        reply,
        403,
        catalogEntry.authMethod === 'api_key'
          ? MCP_CREDENTIAL_ERROR_CODES.SHARED_CREDENTIAL_AUTH_FORBIDDEN
          : MCP_CREDENTIAL_ERROR_CODES.PERSONAL_CREDENTIAL_PRINCIPAL_FORBIDDEN,
        'Only a validated API-key catalog config can store a shared credential. OAuth and personal tokens can only be stored for the person who authenticated them.',
      )
      return reply
    }

    try {
      const credentialRef = await ctx.mcpSecretStore.put({
        accessToken: body.secret,
      })
      const override = await upsertOverride(prisma, {
        instanceId,
        principalType: body.principalType,
        principalId: body.principalId,
        credentialRef,
      })
      return createApiResponse(publicOverride(override))
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
      // Secret writes are brute-force/oracle-sensitive: cap per IP and per owner.
      if (!(await guardMcpSecretWrite(rateLimiter, config.api.rateLimit, request, reply, actorContext))) {
        return reply
      }

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
}
