import { McpCredentialPrincipalTypeSchema } from '@nessie/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import { getInstance, MCP_INSTANCE_ERROR_CODES } from '../../services/mcp-instances.js'
import {
  deleteOverride,
  listOverrides,
  MCP_CREDENTIAL_ERROR_CODES,
  upsertOverride,
} from '../../services/mcp-credentials.js'

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
  credentialRef: z.string().min(1),
})

export const registerMcpCredentialRoutes = (
  app: FastifyInstance,
  ctx: McpSubRegistrarContext,
): void => {
  const { prisma, requireActorContext, requireOwner } = ctx

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
}
