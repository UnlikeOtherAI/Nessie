import type { FastifyInstance } from 'fastify'

import { checkBudget } from '@nessie/runtime'
import { DesignerChatBodySchema } from '../contracts.js'
import { parseInput, sendApiError } from '../lib/api.js'
import { streamDesignerChat } from '../services/designer.js'
import type { RouteDeps } from './types.js'

export const registerDesignerRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, sharedModelClient } = deps

  app.post('/api/designer/chat', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(DesignerChatBodySchema, request.body, reply)
    if (!body) return reply

    if (!sharedModelClient) {
      reply.code(500).send({ error: 'Model client not configured' })
      return reply
    }

    // This endpoint calls the model in-process (not via the worker queue), so it
    // must consult the budget gate itself rather than rely on the worker gates.
    // It is an interactive owner action, so it counts as a human request.
    const budget = await checkBudget(
      prisma,
      {
        organizationId: actorContext.tenant.organizationId,
        projectId: actorContext.tenant.projectId,
        teamId: actorContext.tenant.teamId,
      },
      { isHuman: true },
    )
    if (!budget.allowed) {
      sendApiError(reply, 402, 'BUDGET_EXCEEDED', budget.reason ?? 'Monthly budget exceeded')
      return reply
    }

    await streamDesignerChat(reply, body, sharedModelClient)
    return reply
  })
}
