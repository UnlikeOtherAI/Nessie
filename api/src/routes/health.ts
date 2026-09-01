import type { FastifyInstance } from 'fastify'

import { OpsHealthResponseSchema, ReadinessResponseSchema } from '../contracts.js'
import { createApiResponse } from '../lib/api.js'
import { getOpsHealth, getReadiness } from '../services/ops-health.js'
import type { RouteDeps } from './types.js'

export const registerHealthRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, rateLimiter, requireActorContext, requireSuperAdmin } = deps

  app.get('/api/health', { config: { public: true } }, async () =>
    createApiResponse({
      service: 'api',
      status: 'ok',
    }),
  )

  // Readiness: unlike liveness, this fails (503) when the database is
  // unreachable or the worker has stopped heartbeating, so an orchestrator
  // can act on a degraded backend instead of seeing a permanent 200.
  app.get('/api/health/ready', { config: { public: true } }, async (_request, reply) => {
    const readiness = await getReadiness(prisma)
    const payload = createApiResponse(ReadinessResponseSchema.parse(readiness))
    return reply.code(readiness.ready ? 200 : 503).send(payload)
  })

  // Instance administration, not organisation administration: worker
  // heartbeats, queue counts, dead jobs, and the rate-limiter snapshot are
  // deployment-wide and have no tenant column (`services/ops-health.ts`). Under
  // the old flattened single-organisation model "owner of the shared org" was
  // the only thing resembling an instance administrator; with one Organization
  // per UOA organisation an org owner is just one tenant's administrator, so
  // this is `User.superAdmin` — the named instance-wide role.
  app.get('/api/ops/health', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await requireSuperAdmin(actorContext, reply))) return reply

    const health = await getOpsHealth(
      prisma,
      actorContext.tenant.organizationId,
      rateLimiter,
    )
    return createApiResponse(OpsHealthResponseSchema.parse(health))
  })
}
