import type { FastifyInstance } from 'fastify'

import { GlobalAgentHomeResponseSchema } from '../contracts.js'
import { DEFAULT_BOOTSTRAP_RECORD_IDS } from '../db/bootstrap.js'
import { createApiResponse, sendApiError } from '../lib/api.js'
import { openGlobalAgentHome } from '../services/global-agent-home.js'
import type { RouteDeps } from './types.js'

/**
 * Global agents — the app-provided tier — have one route home of their own, as
 * the Personal Assistant does. Keeping it separate from the PA's file is the
 * point: the PA is an organisation singleton with presence routes, a global
 * agent is a blueprint addressed by slug, and a shared file would invite the
 * two lifecycles to borrow each other's rules.
 */
export const registerGlobalAgentRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  /**
   * Open this person's home DM with a global agent — the doorway behind
   * Create -> Agent on every client. It ensures before it answers, so the chat
   * is reachable even where the best-effort login bootstrap did not run, and
   * every surface (web, desktop, phone) gets there through this one call rather
   * than each reimplementing a lookup with a fallback.
   */
  app.post('/api/global-agents/:slug/home', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !requireUserActor(actorContext, reply)) return reply

    const { slug } = request.params as { slug: string }
    const home = await openGlobalAgentHome(prisma, {
      organizationId: actorContext.tenant.organizationId,
      slug,
      teamId:
        actorContext.tenant.teamId
        ?? actorContext.actionContext.teamId
        ?? DEFAULT_BOOTSTRAP_RECORD_IDS.teamId,
      userId: actorContext.actor.actorId,
    })
    if (!home) {
      sendApiError(reply, 404, 'GLOBAL_AGENT_NOT_FOUND', 'Unknown global agent')
      return reply
    }

    return reply.code(200).send(createApiResponse(GlobalAgentHomeResponseSchema.parse(home)))
  })
}
