import type { FastifyInstance } from 'fastify'
import {
  DeviceTokenRecordSchema,
  RegisterDeviceRequestSchema,
} from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'

/**
 * Device-token registry endpoints.
 *
 * Mobile apps register the native APNs/FCM device token on every launch so the
 * push pipeline can target a user's devices. Tokens are user-scoped: a caller
 * only ever registers/removes tokens for themselves, within their own tenant.
 */
export const registerDeviceRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext } = deps

  // POST /api/devices — register or refresh a native device token. Upsert by
  // the unique (userId, token) so re-registration on every launch is
  // idempotent and only ever touches the caller's own row.
  app.post('/api/devices', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(RegisterDeviceRequestSchema, request.body, reply)
    if (!body) {
      return reply
    }

    const organizationId = actorContext.tenant.organizationId
    const userId = actorContext.actor.actorId

    const device = await prisma.deviceToken.upsert({
      where: { userId_token: { userId, token: body.token } },
      create: {
        organizationId,
        userId,
        platform: body.platform,
        token: body.token,
        appVersion: body.appVersion,
      },
      update: {
        platform: body.platform,
        appVersion: body.appVersion ?? null,
        lastSeenAt: new Date(),
      },
    })

    return reply.code(201).send(
      createApiResponse(
        DeviceTokenRecordSchema.parse({
          id: device.id,
          platform: device.platform,
          token: device.token,
          appVersion: device.appVersion ?? undefined,
          lastSeenAt: device.lastSeenAt.toISOString(),
          createdAt: device.createdAt.toISOString(),
        }),
      ),
    )
  })

  // DELETE /api/devices/:token — unregister the caller's own token. Idempotent:
  // a missing row is not an error. Matched on (userId, token) so a user can
  // never delete another user's token even with a known token value.
  app.delete('/api/devices/:token', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { token } = request.params as { token: string }
    if (!token) {
      sendApiError(reply, 400, 'VALIDATION_ERROR', 'Token is required', 'token')
      return reply
    }

    await prisma.deviceToken.deleteMany({
      where: { userId: actorContext.actor.actorId, token },
    })

    return reply.code(204).send()
  })
}
