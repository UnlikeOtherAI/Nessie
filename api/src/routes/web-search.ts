import type { FastifyInstance } from 'fastify'

import { checkBudget, WebSearchError } from '@nessie/runtime'
import { WebSearchRequestSchema } from '@nessie/schemas'
import { parseInput, sendApiError } from '../lib/api.js'
import { isWebSearchConfigured, searchWebForPerson } from '../services/web-search.js'
import type { RouteDeps } from './types.js'

/**
 * `POST /api/web-search` — the one door a *person* searches the web through.
 *
 * It exists because a search card is a place to search from: the agent posts
 * the page it fetched, and paging on from there is the reader's own request,
 * not a replay of the agent's. So the search runs under the reader's identity,
 * spends against their organisation's Ledger, and passes the same budget gate
 * an interactive model call passes — a click that costs money is still a cost.
 */
export const registerWebSearchRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { ledgerIdentity, prisma, requireActorContext } = deps

  app.post('/api/web-search', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(WebSearchRequestSchema, request.body, reply)
    if (!body) return reply

    if (!isWebSearchConfigured(ledgerIdentity)) {
      sendApiError(
        reply,
        503,
        'WEB_SEARCH_UNCONFIGURED',
        'Web search is not configured on this deployment.',
      )
      return reply
    }

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

    try {
      const card = await searchWebForPerson({
        actorContext,
        ledgerIdentity: ledgerIdentity!,
        request: body,
        requestId: request.id,
      })
      return reply.send(card)
    } catch (error) {
      if (error instanceof WebSearchError) {
        sendApiError(reply, 502, 'WEB_SEARCH_FAILED', error.message)
        return reply
      }
      throw error
    }
  })
}
