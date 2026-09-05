import type { FastifyInstance } from 'fastify'

import { OpsHealthResponseSchema, ReadinessResponseSchema } from '../contracts.js'
import { createApiResponse } from '../lib/api.js'
import { isDraining } from '../lifecycle.js'
import { getOpsHealth, getReadiness } from '../services/ops-health.js'
import type { RouteDeps } from './types.js'

export const registerHealthRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, rateLimiter, requireActorContext, requireSuperAdmin } = deps

  // Liveness: is this process still running? A flat 200 until the process
  // begins draining, at which point it answers 503 so an orchestrator that
  // probes liveness (rather than readiness) also stops routing here instead of
  // watching requests land on a replica that is closing its sockets.
  app.get('/api/health', { config: { public: true } }, async (_request, reply) => {
    const payload = createApiResponse({
      service: 'api',
      status: isDraining() ? 'draining' : 'ok',
    })
    return reply.code(isDraining() ? 503 : 200).send(payload)
  })

  // Readiness — the load-balancer probe. May this replica take new requests?
  // Exactly two things can say no: its own database round trip failed, or it is
  // draining. Worker heartbeats deliberately do NOT gate this. They used to,
  // and a worker outage or a worker deploy would then 503 every API replica at
  // once and empty the load balancer, taking the whole product down over a
  // subsystem the API does not need to serve a request. The heartbeat signal
  // stays on `/api/ops/health`, where an operator reads it; `getReadiness`
  // still reports it in `checks.worker` for that reason, as information.
  app.get('/api/health/ready', { config: { public: true } }, async (_request, reply) => {
    const readiness = await getReadiness(prisma)
    const ready = readiness.checks.database && !isDraining()
    const payload = createApiResponse(
      ReadinessResponseSchema.parse({ ...readiness, ready }),
    )
    return reply.code(ready ? 200 : 503).send(payload)
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
