import type { FastifyInstance } from 'fastify'

import {
  RegisterVoiceInstallationRequestSchema,
  VoiceCapabilitySchema,
  VoiceInstallationRecordSchema,
} from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { isVoiceConfigured } from '../services/voice/ledger-gemini-live.js'
import { registerVoiceInstallation } from '../services/voice/voice-session.js'
import { sendVoiceError } from './voice-route-errors.js'

import type { RouteDeps } from './types.js'

/**
 * Enrolment: whether this deployment can call at all, and which device is
 * calling.
 *
 * Separate from the call itself because it happens before any call and
 * outlives every one of them — a device slot is a durable thing an owner can
 * see and revoke, while a session is a few minutes of audio. Ledger reserves
 * daily budget per device slot, which is why the id is server-minted here and
 * never chosen by a client.
 */
export const registerVoiceEnrolmentRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext } = deps

  // Asked before the call button is offered, so a deployment with no Ledger
  // shows no control instead of one that always fails.
  app.get('/api/voice/capability', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    return createApiResponse(VoiceCapabilitySchema.parse({ available: isVoiceConfigured() }))
  })

  app.post('/api/voice/installations', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(RegisterVoiceInstallationRequestSchema, request.body ?? {}, reply)
    if (!body) return reply

    try {
      const installation = await registerVoiceInstallation(prisma, {
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
        platform: body.platform,
        label: body.label,
      })
      return reply.code(201).send(
        createApiResponse(
          VoiceInstallationRecordSchema.parse({
            id: installation.id,
            platform: installation.platform,
            ...(installation.label ? { label: installation.label } : {}),
            lastSeenAt: installation.lastSeenAt.toISOString(),
            createdAt: installation.createdAt.toISOString(),
          }),
        ),
      )
    } catch (error) {
      return sendVoiceError(reply, error) ?? Promise.reject(error)
    }
  })

  app.delete('/api/voice/installations/:installationId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { installationId } = request.params as { installationId: string }

    // Revoked rather than deleted: sessions reference it, and the row is how
    // an owner sees which device held a Ledger reservation today.
    const revoked = await prisma.voiceInstallation.updateMany({
      where: {
        id: installationId,
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    })
    if (revoked.count === 0) {
      return sendApiError(reply, 404, 'VOICE_INSTALLATION_NOT_FOUND', 'Device not found.')
    }
    return reply.code(204).send()
  })
}
