import type { FastifyInstance } from 'fastify'
import {
  WebPushConfigResponseSchema,
  WebPushSubscribeRequestSchema,
  WebPushSubscriptionRecordSchema,
  WebPushUnsubscribeRequestSchema,
} from '@nessie/schemas'
import { assertSafeUrl, UrlSafetyError } from '@nessie/runtime'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { trimWebPushSubscriptionCap } from '../services/web-push-subscriptions.js'
import type { RouteDeps } from './types.js'

// User-Agent strings can be arbitrarily long; clamp to a sane DB-friendly size
// so a hostile client can't bloat the row.
const MAX_USER_AGENT_LENGTH = 512

/**
 * Web Push subscription endpoints.
 *
 * Browsers register a Push API subscription so the push pipeline can deliver
 * notifications via VAPID. A row is a tenant/user enrollment of the browser's
 * PushSubscription: a caller only ever registers/removes their own enrollment
 * in their current tenant.
 * Web push is "enabled" iff the VAPID public/private keys and subject are all
 * configured (`config.webPush`).
 */
export const registerWebPushRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { config, prisma, requireActorContext } = deps

  // GET /api/push/web/config — advertise whether web push is enabled and the
  // VAPID public key browsers need to subscribe. Requires auth.
  app.get('/api/push/web/config', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const organizationId = actorContext.tenant.organizationId
    const userId = actorContext.actor.actorId
    const registrations = await prisma.webPushSubscription.findMany({
      where: { organizationId, userId },
      select: { endpoint: true },
    })
    const { publicKey, privateKey, subject } = config.webPush
    const enabled = Boolean(publicKey && privateKey && subject)

    return createApiResponse(
      WebPushConfigResponseSchema.parse({
        enabled,
        publicKey: publicKey ?? null,
        registeredEndpoints: registrations.map((registration) => registration.endpoint),
      }),
    )
  })

  // POST /api/push/web/subscribe — register or refresh a browser push
  // subscription. Upsert by (organizationId, userId, endpoint) so re-subscribing
  // is idempotent and only ever touches the caller's own current-tenant row.
  app.post('/api/push/web/subscribe', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(WebPushSubscribeRequestSchema, request.body, reply)
    if (!body) {
      return reply
    }

    // SSRF guard: the endpoint becomes an outbound POST target in the worker, so
    // reject private/internal hosts (and non-http(s) schemes) up front. The
    // schema already requires https; this resolves DNS and blocks internal IPs.
    try {
      await assertSafeUrl(body.endpoint)
    } catch (error) {
      if (error instanceof UrlSafetyError) {
        sendApiError(reply, 400, 'UNSAFE_ENDPOINT', 'Push endpoint is not allowed')
        return reply
      }
      throw error
    }

    const organizationId = actorContext.tenant.organizationId
    const userId = actorContext.actor.actorId
    const userAgent = request.headers['user-agent']?.slice(0, MAX_USER_AGENT_LENGTH) ?? null

    const subscription = await prisma.webPushSubscription.upsert({
      where: {
        organizationId_userId_endpoint: { organizationId, userId, endpoint: body.endpoint },
      },
      create: {
        organizationId,
        userId,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent,
        lastSeenAt: new Date(),
      },
      update: {
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent,
        lastSeenAt: new Date(),
      },
    })

    // Bound table growth: keep only the most-recently-seen subscriptions, evicting
    // the oldest beyond the cap (covers the case where this upsert created a new row).
    await trimWebPushSubscriptionCap(prisma, { organizationId, userId })

    return reply.code(201).send(
      createApiResponse(
        WebPushSubscriptionRecordSchema.parse({
          id: subscription.id,
          endpoint: subscription.endpoint,
          lastSeenAt: subscription.lastSeenAt.toISOString(),
          createdAt: subscription.createdAt.toISOString(),
        }),
      ),
    )
  })

  // POST /api/push/web/unsubscribe — remove the caller's own subscription.
  // Idempotent: a missing row is not an error. It removes the server enrollment
  // only: the browser's shared PushSubscription remains available to another
  // explicitly enrolled tenant.
  app.post('/api/push/web/unsubscribe', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(WebPushUnsubscribeRequestSchema, request.body, reply)
    if (!body) {
      return reply
    }

    await prisma.webPushSubscription.deleteMany({
      where: {
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
        endpoint: body.endpoint,
      },
    })

    return reply.code(204).send()
  })

  // POST /api/push/web/logout — remove this browser endpoint from every
  // enrollment held by the person ending their session. The PushSubscription
  // itself remains browser-owned, but a later person must explicitly enroll it.
  app.post('/api/push/web/logout', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(WebPushUnsubscribeRequestSchema, request.body, reply)
    if (!body) return reply

    await prisma.webPushSubscription.deleteMany({
      where: { endpoint: body.endpoint, userId: actorContext.actor.actorId },
    })
    return reply.code(204).send()
  })
}
