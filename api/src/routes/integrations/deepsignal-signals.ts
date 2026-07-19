import type { FastifyInstance } from 'fastify'
import { createMcpSecretResolver } from '@nessie/mcp-manage'
import {
  DeepSignalSignalActRequestSchema,
  DeepSignalSignalActResponseSchema,
  DeepSignalSignalsResponseSchema,
} from '@nessie/schemas'
import { attributionFromActorContext } from '@nessie/runtime'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import {
  actOnDeepSignalSignal,
  listDeepSignalSignals,
  type DeepSignalDigestInclude,
} from '../../services/deepsignal-signals.js'
import type { RouteDeps } from '../types.js'

/**
 * DeepSignal Signals surface (surface-registry plan §4). Reads the user's
 * insight digest over their own user-scoped DeepSignal MCP instance and proxies
 * done/snooze/mute/reopen actions back — reusing the shared
 * `resolveUserScopedProductTransport` + `callInstanceTool` seam, no forked MCP
 * client. Tenancy is strictly the authenticated principal; the insight id is the
 * only caller-supplied argument. Not-linked → `needs_setup` (never a 500).
 */

const IncludeQuerySchema = z.object({
  include: z.enum(['active', 'all']).default('active'),
})
const InsightIdParamsSchema = z.object({ insightId: z.string().min(1) })

export const registerDeepSignalSignalsRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const {
    prisma,
    requireActorContext,
    requireUserActor,
    authSecret,
    deepSignalMcpIdentity,
  } = deps
  const secretResolver = createMcpSecretResolver(prisma, authSecret ?? '')

  app.get('/api/integrations/products/deepsignal/signals', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const query = parseInput(IncludeQuerySchema, request.query, reply, 'query')
    if (!query) return reply

    try {
      const result = await listDeepSignalSignals(
        prisma,
        {
          attribution: attributionFromActorContext(actorContext, {
            systemComponent: 'api-deepsignal-signals',
          }),
          deepSignalIdentity: deepSignalMcpIdentity,
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
        },
        secretResolver,
        query.include as DeepSignalDigestInclude,
      )
      return createApiResponse(DeepSignalSignalsResponseSchema.parse(result))
    } catch {
      // Not-linked fails closed to `needs_setup` inside the service; a throw here
      // is an upstream/MCP tool failure — surface it as 502, like external-sync.
      sendApiError(reply, 502, 'UPSTREAM_UNAVAILABLE', 'DeepSignal is unavailable')
      return reply
    }
  })

  app.post(
    '/api/integrations/products/deepsignal/signals/:insightId/act',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply
      if (!requireUserActor(actorContext, reply)) return reply

      const params = parseInput(InsightIdParamsSchema, request.params, reply, 'params')
      if (!params) return reply
      const body = parseInput(DeepSignalSignalActRequestSchema, request.body, reply)
      if (!body) return reply

      try {
        const result = await actOnDeepSignalSignal(
          prisma,
          {
            attribution: attributionFromActorContext(actorContext, {
              systemComponent: 'api-deepsignal-signal-action',
            }),
            deepSignalIdentity: deepSignalMcpIdentity,
            organizationId: actorContext.tenant.organizationId,
            userId: actorContext.actor.actorId,
          },
          secretResolver,
          params.insightId,
          body.action,
        )
        return createApiResponse(DeepSignalSignalActResponseSchema.parse(result))
      } catch {
        sendApiError(reply, 502, 'UPSTREAM_UNAVAILABLE', 'DeepSignal is unavailable')
        return reply
      }
    },
  )
}
