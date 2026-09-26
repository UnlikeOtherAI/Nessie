import type { FastifyInstance } from 'fastify'
import {
  AccessCheckResultSchema,
  parseAccessCheckContext,
  parseListedAccountId,
} from '@nessie/schemas'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { runAccessCheck } from '../services/accounts/access-check/access-check.js'
import { accountViewer } from './accounts.js'
import type { RouteDeps } from './types.js'

/**
 * `GET /api/accounts/:accountId/access-check?agentId=&context=direct|unattended|channel:<id>`
 *
 * Check access (plan §6.7, §10.13): the steps the runtime takes for one
 * agent, one account and one place it is asked from. A read: it opens no
 * credential, calls no provider and writes nothing. An account, an agent or a
 * conversation the viewer cannot see answers exactly as one that does not
 * exist.
 */

const Query = z.object({
  agentId: z.string().uuid(),
  context: z.string().max(80).optional(),
}).strict()

const NOT_FOUND = {
  account: ['ACCOUNT_NOT_FOUND', 'That account could not be found.'],
  agent: ['AGENT_NOT_FOUND', 'That agent could not be found.'],
  context: ['CONTEXT_NOT_FOUND', 'That conversation could not be found.'],
} as const

export const registerAccessCheckRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  app.get('/api/accounts/:accountId/access-check', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    const query = parseInput(Query, request.query, reply, 'query')
    if (!query) return reply
    const context = parseAccessCheckContext(query.context)
    if (!context) {
      sendApiError(reply, 400, 'VALIDATION_ERROR', 'Name a context: direct, unattended or channel:<id>.', 'context')
      return reply
    }
    const target = parseListedAccountId((request.params as { accountId: string }).accountId)
    if (!target) {
      sendApiError(reply, 404, NOT_FOUND.account[0], NOT_FOUND.account[1])
      return reply
    }
    const outcome = await runAccessCheck(deps.prisma, accountViewer(actor), actor, {
      agentId: query.agentId,
      context,
      target,
    })
    if (outcome.kind === 'not_found') {
      const [code, message] = NOT_FOUND[outcome.what]
      sendApiError(reply, 404, code, message)
      return reply
    }
    if (outcome.kind === 'not_applicable') {
      sendApiError(reply, 409, 'ACCESS_CHECK_NOT_APPLICABLE', outcome.message)
      return reply
    }
    return createApiResponse(AccessCheckResultSchema.parse(outcome.result))
  })
}
