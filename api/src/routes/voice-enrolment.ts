import type { FastifyInstance } from 'fastify'

import {
  RegisterVoiceInstallationRequestSchema,
  VoiceCapabilitySchema,
  VoiceDeviceTokenRequestSchema,
  VoiceDeviceTokenSchema,
  VoiceInstallationRecordSchema,
} from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { isVoiceConfigured } from '../services/voice/ledger-gemini-live.js'
import { registerVoiceInstallation } from '../services/voice/voice-session.js'
import {
  mintVoiceDeviceCredential,
  revokeVoiceDeviceCredentials,
  rotateVoiceDeviceCredential,
  VOICE_CREDENTIAL_REFRESH_WINDOW_MS,
} from '../services/voice/voice-device-credential.js'
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

  /** The token, plus when the native side should start refreshing it. */
  const tokenResponse = (minted: { token: string; credential: { expiresAt: Date; installationId: string } }) =>
    VoiceDeviceTokenSchema.parse({
      expiresAt: minted.credential.expiresAt.toISOString(),
      installationId: minted.credential.installationId,
      refreshAfter: new Date(
        minted.credential.expiresAt.getTime() - VOICE_CREDENTIAL_REFRESH_WINDOW_MS,
      ).toISOString(),
      token: minted.token,
    })

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
    // Revoking the slot has to take the phone's credential with it, or
    // "revoke this device" would leave a working token on the device it named.
    await revokeVoiceDeviceCredentials(prisma, installationId)
    return reply.code(204).send()
  })

  /**
   * Mints the credential the native layer holds during a call.
   *
   * Ordinary session auth on purpose: the WebView is the only provisioning
   * path, which is what binds the credential to a real sign-in. The token is
   * returned once and never again — the server keeps only its digest.
   */
  app.post('/api/voice/device-token', async (request, reply) => {
    // No `duringACall` marker, which is the point: a credential minted *by* a
    // credential would renew itself past the sign-out that should have ended
    // it. The auth hook refuses a device credential here before the handler
    // runs, so the only way in is a real session. Renewal is the rotate route,
    // which carries the original sign-in forward rather than deriving a new one.
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(VoiceDeviceTokenRequestSchema, request.body ?? {}, reply)
    if (!body) return reply

    // The session this credential dies with, and the generation it belongs to.
    const sessionId = actorContext.actionContext.sessionId
    if (!sessionId) {
      return sendApiError(
        reply,
        401,
        'AUTH_REQUIRED',
        'A voice credential can only be minted from a signed-in session.',
      )
    }
    const user = await prisma.user.findUnique({
      select: { tokenVersion: true },
      where: { id: actorContext.actor.actorId },
    })
    if (!user) {
      return sendApiError(reply, 401, 'USER_NOT_FOUND', 'User no longer exists')
    }
    const { projectId, teamId } = actorContext.tenant
    if (!projectId || !teamId) {
      return sendApiError(
        reply,
        400,
        'VOICE_CONTEXT_REQUIRED',
        'A workspace context is required to provision a device.',
      )
    }

    try {
      const minted = await mintVoiceDeviceCredential(prisma, {
        installationId: body.installationId,
        organizationId: actorContext.tenant.organizationId,
        projectId,
        sessionId,
        teamId,
        tokenVersion: user.tokenVersion,
        userId: actorContext.actor.actorId,
      })
      return reply.code(201).send(createApiResponse(tokenResponse(minted)))
    } catch (error) {
      return sendVoiceError(reply, error) ?? Promise.reject(error)
    }
  })

  /**
   * Rotates the credential, from the native side.
   *
   * The only route that both accepts the credential and is not part of a call:
   * a locked-phone call outlives any foreground refresh, so the device has to
   * renew itself. Rotation carries the original sign-in forward rather than
   * re-deriving one, so it can never launder a credential past a sign-out —
   * the next verification would fail on that session anyway.
   */
  app.post(
    '/api/voice/device-token/refresh',
    { config: { voiceCredential: true } },
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply
      const presented = request.voiceCredential
      if (!presented) {
        return sendApiError(
          reply,
          401,
          'VOICE_CREDENTIAL_INVALID',
          'This route is for the device credential.',
        )
      }
      try {
        const minted = await rotateVoiceDeviceCredential(prisma, presented)
        return reply.code(201).send(createApiResponse(tokenResponse(minted)))
      } catch (error) {
        return sendVoiceError(reply, error) ?? Promise.reject(error)
      }
    },
  )
}
