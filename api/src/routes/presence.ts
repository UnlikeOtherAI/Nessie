import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { PushSurface } from '@nessie/schemas'
import {
  PresenceEntrySchema,
  PresenceHeartbeatBodySchema,
  PresenceListResponseSchema,
  PushSurfaceHeartbeatBodySchema,
  SetManualPresenceBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput } from '../lib/api.js'
import {
  getPresenceEntry,
  listOrganizationPresence,
  recordHeartbeat,
  setManualState,
} from '../services/presence.js'
import { recordPushSurfacePresence } from '../services/push-surface-presence.js'
import type { RouteDeps } from './types.js'

export const registerPresenceRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  const actorFromRequest = (request: FastifyRequest, reply: FastifyReply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return null
    if (!requireUserActor(actorContext, reply)) return null
    return {
      organizationId: actorContext.tenant.organizationId,
      sessionId: actorContext.actionContext.sessionId ?? '',
      userId: actorContext.actor.actorId,
    }
  }

  // Org-wide live state + active custom status, polled by the admin to badge
  // every human avatar.
  app.get('/api/presence', async (request, reply) => {
    const actor = actorFromRequest(request, reply)
    if (!actor) return reply

    const users = await listOrganizationPresence(prisma, actor.organizationId)
    return createApiResponse(PresenceListResponseSchema.parse({ users }))
  })

  // Manual override for the signed-in user (`null` reverts to auto-detection).
  app.put('/api/presence/me', async (request, reply) => {
    const actor = actorFromRequest(request, reply)
    if (!actor) return reply

    const body = parseInput(SetManualPresenceBodySchema, request.body, reply)
    if (!body) return reply

    await setManualState(prisma, actor.userId, actor.organizationId, body.state)
    const entry = await getPresenceEntry(prisma, actor.organizationId, actor.userId)
    return createApiResponse(PresenceEntrySchema.parse(entry))
  })

  // Liveness + activity heartbeat from the signed-in client.
  app.post('/api/presence/heartbeat', async (request, reply) => {
    const actor = actorFromRequest(request, reply)
    if (!actor) return reply

    const body = parseInput(PresenceHeartbeatBodySchema, request.body, reply)
    if (!body) return reply

    await recordHeartbeat(prisma, actor.userId, actor.organizationId, body.active)
    return createApiResponse({ ok: true })
  })

  // A short-lived per-session page signal for push suppression. The payload is
  // structured (channel or ops page), never a caller-controlled URL.
  app.post('/api/push-surfaces/heartbeat', async (request, reply) => {
    const actor = actorFromRequest(request, reply)
    if (!actor) return reply

    const body = parseInput(PushSurfaceHeartbeatBodySchema, request.body, reply)
    if (!body) return reply

    await recordPushSurfacePresence(prisma, {
      clientId: body.clientId,
      organizationId: actor.organizationId,
      sequence: BigInt(body.sequence),
      sessionId: actor.sessionId,
      // parseInput has already validated this schema; its generic boundary
      // intentionally returns unbranded strings, so preserve the validated
      // PushSurface output type without parsing the same body twice.
      surface: body.surface as PushSurface | null,
      userId: actor.userId,
    })
    return createApiResponse({ ok: true })
  })
}
