import crypto from 'node:crypto'

import type { FastifyInstance, FastifyReply } from 'fastify'
import { LOCAL_INFERENCE_ENABLED_SETTING_KEY, resolveScopedSetting } from '@nessie/runtime'

import { EnrollLocalInferenceHostBodySchema } from '../contracts/local-inference.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'

type ExistingHost = {
  custodianUserId: string
  id: string
  organizationId: string
  revokedAt: Date | null
  transport: 'desktop' | 'executor'
}

const hostUnavailable = (reply: FastifyReply): void => {
  sendApiError(reply, 404, 'LOCAL_HOST_UNAVAILABLE', 'Local host unavailable.')
}

const requireUsableHost = (
  reply: FastifyReply,
  existing: ExistingHost | null,
  actorId: string,
  organizationId: string,
): ExistingHost | null => {
  if (!existing) return null
  if (
    existing.transport !== 'desktop'
    || existing.custodianUserId !== actorId
    || existing.organizationId !== organizationId
  ) {
    hostUnavailable(reply)
    return null
  }
  if (existing.revokedAt) {
    sendApiError(reply, 409, 'KEY_ROTATION_REQUIRED',
      'This local host was revoked. Replace this computer’s local key before reconnecting it.')
    return null
  }
  return existing
}

const isUniqueViolation = (error: unknown): boolean => (
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
)

/** Desktop machine keys are durable. Re-enrollment is idempotent only for the
 * exact live owner/org identity; a revoked fingerprint is deliberately a
 * repair fence rather than a path to resurrect server-side authority. */
export const registerLocalInferenceDesktopEnrollmentRoute = (
  app: FastifyInstance,
  { prisma, requireActorContext, requireUserActor }: RouteDeps,
): void => {
  app.post('/api/local-inference/hosts/enroll', async (request, reply) => {
    const actor = requireActorContext(request, reply)
    if (!actor || !requireUserActor(actor, reply)) return reply
    const body = parseInput(EnrollLocalInferenceHostBodySchema, request.body, reply)
    if (!body) return reply
    const enabled = await resolveScopedSetting<boolean>(prisma, {
      organizationId: actor.tenant.organizationId,
      userId: actor.actor.actorId,
    }, LOCAL_INFERENCE_ENABLED_SETTING_KEY)
    if (enabled.value !== true) {
      sendApiError(reply, 403, 'POLICY_DENIED', 'Local models are disabled for this work.')
      return reply
    }
    let publicKey: crypto.KeyObject
    try {
      publicKey = crypto.createPublicKey(body.publicKey)
    } catch {
      sendApiError(reply, 400, 'VALIDATION_ERROR', 'The local host public key is invalid.')
      return reply
    }
    const fingerprint = crypto.createHash('sha256')
      .update(publicKey.export({ format: 'der', type: 'spki' }))
      .digest('hex')
    const existing = await prisma.localInferenceHost.findUnique({
      where: { publicKeyFingerprint: fingerprint },
      select: { custodianUserId: true, id: true, organizationId: true, revokedAt: true, transport: true },
    })
    const known = requireUsableHost(reply, existing, actor.actor.actorId, actor.tenant.organizationId)
    if (known) {
      reply.header('Cache-Control', 'no-store')
      return createApiResponse({ hostId: known.id, organizationId: actor.tenant.organizationId })
    }
    if (existing) return reply

    try {
      const host = await prisma.localInferenceHost.create({
        data: {
          custodianUserId: actor.actor.actorId,
          displayLabel: body.displayLabel,
          organizationId: actor.tenant.organizationId,
          publicKey: body.publicKey,
          publicKeyFingerprint: fingerprint,
          transport: 'desktop',
        },
        select: { id: true },
      })
      reply.header('Cache-Control', 'no-store')
      return createApiResponse({ hostId: host.id, organizationId: actor.tenant.organizationId })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      const raced = await prisma.localInferenceHost.findUnique({
        where: { publicKeyFingerprint: fingerprint },
        select: { custodianUserId: true, id: true, organizationId: true, revokedAt: true, transport: true },
      })
      const host = requireUsableHost(reply, raced, actor.actor.actorId, actor.tenant.organizationId)
      if (!host) return reply
      reply.header('Cache-Control', 'no-store')
      return createApiResponse({ hostId: host.id, organizationId: actor.tenant.organizationId })
    }
  })
}
