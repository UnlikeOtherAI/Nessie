import type { FastifyInstance } from 'fastify'
import {
  DeviceTokenRecordSchema,
  RegisterDeviceRequestSchema,
} from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { registerDeviceToken } from '../services/device-token-registration.js'
import { nextPushRegistrationGeneration } from '../services/push-registration-generation.js'
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

  // POST /api/devices — register or refresh a native device token. A token is
  // one physical installation, so re-registering atomically transfers it to
  // the current user + organization rather than leaking a former user's alerts.
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

    const registrationVersion = BigInt(actorContext.actionContext.pushRegistrationVersion ?? '0')
    const result = await registerDeviceToken(prisma, { ...body, organizationId, registrationVersion, userId })
    if (result.kind === 'ownership_proof_required') {
      sendApiError(reply, 403, 'DEVICE_OWNERSHIP_PROOF_REQUIRED', 'This device must approve its account switch.')
      return reply
    }
    const { device } = result

    return reply.code(201).send(
      createApiResponse(
        DeviceTokenRecordSchema.parse({
          id: device.id,
          platform: device.platform,
          token: device.token,
          appVersion: device.appVersion ?? undefined,
          apnsEnvironment: device.apnsEnvironment ?? undefined,
          ownershipProof: result.kind === 'registered' ? result.ownershipProof : undefined,
          lastSeenAt: device.lastSeenAt.toISOString(),
          createdAt: device.createdAt.toISOString(),
        }),
      ),
    )
  })

  // DELETE /api/devices/:token — unregister the caller's own token. The record
  // becomes a non-deliverable tombstone instead of being deleted: preserving a
  // generation newer than this session rejects any request already in flight.
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

    const tombstoneVersion = await nextPushRegistrationGeneration(prisma)
    await prisma.deviceToken.updateMany({
      where: {
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
        token,
      },
      data: { inactiveAt: new Date(), registrationVersion: tombstoneVersion },
    })

    return reply.code(204).send()
  })
}
