import type { FastifyInstance } from 'fastify'

import { checkBudget } from '@nessie/runtime'
import { AGENT_DESIGNER_SLUG } from '@nessie/team-admin'
import { DesignerChatBodySchema, DesignerContinueBodySchema } from '../contracts/designer.js'
import { parseInput, sendApiError } from '../lib/api.js'
import { buildStreamCorsHeaders } from '../lib/server-context.js'
import { resolveDesignerModel, streamDesignerChat } from '../services/designer.js'
import {
  continueDesignInChat,
  GlobalAgentChatError,
} from '../services/global-agent-chat.js'
import type { RouteDeps } from './types.js'

export const registerDesignerRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    config,
    allowedCorsOrigins,
    ledgerIdentity,
    prisma,
    requireActorContext,
    sharedModelClient,
  } = deps

  app.post('/api/designer/chat', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(DesignerChatBodySchema, request.body, reply)
    if (!body) return reply

    if (!sharedModelClient) {
      sendApiError(reply, 500, 'MODEL_CLIENT_NOT_CONFIGURED', 'Model client not configured')
      return reply
    }

    // This endpoint calls the model in-process (not via the worker queue), so it
    // must consult the budget gate itself rather than rely on the worker gates.
    // It is an interactive owner action, so it counts as a human request.
    const budgetDecision = await checkBudget(
      prisma,
      {
        organizationId: actorContext.tenant.organizationId,
        projectId: actorContext.tenant.projectId,
        teamId: actorContext.tenant.teamId,
      },
      { isHuman: true },
    )
    if (budgetDecision.action === 'block') {
      sendApiError(reply, 402, 'BUDGET_EXCEEDED', budgetDecision.reason)
      return reply
    }
    // A 'degrade' decision is intentionally a no-op here: the Designer already
    // resolves the cheapest model the deployment offers it (blueprint pin, else
    // `NESSIE_DESIGNER_MODEL`, else the organisation default), so there is
    // nothing more economical to fall back to. Only a hard block stops this.

    await streamDesignerChat(
      reply,
      body,
      sharedModelClient,
      {
        actorContext,
        // The blueprint's rule, so the usage record names the model actually
        // called and both faces of the Designer resolve it the same way.
        designerModel: resolveDesignerModel(sharedModelClient),
        ledgerIdentity,
        modelProvider: config.model.provider,
        prisma,
      },
      buildStreamCorsHeaders({
        origin: request.headers.origin,
        allowedOrigins: allowedCorsOrigins,
        mode: config.mode,
      }),
    )
    return reply
  })

  // The sidebar's doorway into the full conversation. It hands the current
  // draft over the way `agent_handoff` hands a brief over — one shared
  // delivery, a hidden server-authored `system` message — and answers with the
  // channel to navigate to.
  app.post('/api/designer/continue-in-chat', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(DesignerContinueBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const result = await continueDesignInChat(prisma, {
        actorContext,
        body,
        slug: AGENT_DESIGNER_SLUG,
      })
      return reply.send(result)
    } catch (error) {
      if (error instanceof GlobalAgentChatError) {
        sendApiError(reply, error.status, error.code, error.message)
        return reply
      }
      throw error
    }
  })
}
