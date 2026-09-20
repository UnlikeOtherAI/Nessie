import crypto from 'node:crypto'

import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  LOCAL_INFERENCE_ENABLED_SETTING_KEY,
  resolveScopedSetting,
} from '@nessie/runtime'
import { LocalInferenceHostListSchema } from '@nessie/schemas'
import { assertAgentEditAuthority } from '@nessie/team-admin'
import { verifyLocalInferenceEnvelope } from '@nessie/local-inference-host'

import {
  ConfirmLocalInferenceBindingBodySchema,
  EnrollLocalInferenceHostBodySchema,
  LocalInferenceHeartbeatRequestSchema,
  PrepareLocalInferenceBindingBodySchema,
} from '../contracts/local-inference.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  confirmLocalInferenceBinding,
  LocalInferenceBindingError,
  prepareLocalInferenceBinding,
} from '../services/local-inference-bindings.js'
import type { RouteDeps } from './types.js'

const HostIdParamsSchema = z.object({ hostId: z.string().uuid() })
const AgentIdParamsSchema = z.object({ agentId: z.string().uuid() })

const sendBindingError = (reply: FastifyReply, error: unknown): boolean => {
  if (!(error instanceof LocalInferenceBindingError)) return false
  const status = error.code === 'NOT_FOUND' ? 404
    : error.code === 'ENTITLEMENT_UNAVAILABLE' ? 503
      : error.code.endsWith('CONFLICT') || error.code === 'CHALLENGE_INVALID' ? 409
        : 403
  sendApiError(reply, status, error.code, error.message)
  return true
}

/** Owner-host-only surfaces. Browser sessions may list/select their own host;
 * native daemon confirmation remains signature-proven and cannot be replaced
 * with a session cookie. */
export const registerLocalInferenceRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  app.get('/api/local-inference/hosts', async (request, reply) => {
    const actor = requireActorContext(request, reply)
    if (!actor || !requireUserActor(actor, reply)) return reply
    const rows = await prisma.localInferenceHost.findMany({
      where: {
        custodianUserId: actor.actor.actorId,
        organizationId: actor.tenant.organizationId,
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: {
        id: true, inventory: true, inventoryObservedAt: true, lastSeenAt: true,
        pausedAt: true, revokedAt: true, transport: true,
      },
    })
    const now = Date.now()
    return createApiResponse(LocalInferenceHostListSchema.parse({
      hosts: rows.map((host) => ({
        availability: host.revokedAt || host.pausedAt || !host.lastSeenAt || now - host.lastSeenAt.getTime() > 60_000
          ? 'offline' : 'online',
        canonicalSocket: null,
        id: host.id,
        lastSeenAt: host.lastSeenAt?.toISOString() ?? null,
        models: Array.isArray(host.inventory) ? host.inventory : [],
        status: host.revokedAt ? 'revoked' : 'unconfigured',
        transport: host.transport,
      })),
      meta: { hasMore: false, total: rows.length },
    }))
  })

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
    return createApiResponse({ hostId: host.id })
  })

  // A host may advertise only a signed, bounded observation of its own local
  // Ollama. This route has no user-session substitute: a copied browser cookie
  // cannot extend a device lease or publish an inventory.
  app.post('/api/local-inference/daemon/heartbeat', async (request, reply) => {
    const body = parseInput(LocalInferenceHeartbeatRequestSchema, request.body, reply)
    if (!body) return reply
    const host = await prisma.localInferenceHost.findFirst({
      where: {
        id: body.envelope.hostId,
        organizationId: body.envelope.organizationId,
        revokedAt: null,
      },
      select: { connectionEpoch: true, id: true, organizationId: true, publicKey: true },
    })
    const verified = host?.publicKey
      ? verifyLocalInferenceEnvelope({
          body: body.heartbeat,
          envelope: body.envelope,
          machinePublicKey: host.publicKey,
        })
      : { ok: false as const }
    const sentAt = Date.parse(body.envelope.sentAt)
    const fresh = Number.isFinite(sentAt) && Math.abs(Date.now() - sentAt) <= 30_000
    if (
      !host
      || !verified.ok
      || !fresh
      || body.envelope.purpose !== 'heartbeat'
      || BigInt(body.envelope.connectionEpoch) !== BigInt(host.connectionEpoch)
    ) {
      // No distinction between unknown, revoked, stale and unauthenticated
      // hosts: exposing it would become a tenant/device enumeration oracle.
      sendApiError(reply, 404, 'LOCAL_HOST_UNAVAILABLE', 'Local host unavailable.')
      return reply
    }
    const accepted = await prisma.$transaction(async (tx) => {
      // A separate purpose lane is deliberate: a long poll never serializes a
      // fresh heartbeat, while an old signed heartbeat cannot replay forever.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`local-inference-host:${host.id}:heartbeat`}::text, 0)
        )
      `
      const sequence = await tx.localInferenceHostSequence.findUnique({
        where: { hostId_purpose: { hostId: host.id, purpose: 'heartbeat' } },
        select: { lastSequence: true },
      })
      const next = BigInt(body.envelope.sequence)
      if (sequence && sequence.lastSequence >= next) return false
      await tx.localInferenceHostSequence.upsert({
        where: { hostId_purpose: { hostId: host.id, purpose: 'heartbeat' } },
        create: { hostId: host.id, lastSequence: next, purpose: 'heartbeat' },
        update: { lastSequence: next },
      })
      await tx.localInferenceHost.update({
        where: { id: host.id },
        data: {
          inventory: body.heartbeat.inventory,
          inventoryObservedAt: new Date(),
          lastSeenAt: new Date(),
          pausedAt: body.heartbeat.paused ? new Date() : null,
        },
      })
      return true
    })
    if (!accepted) {
      sendApiError(reply, 409, 'LOCAL_HOST_REPLAY', 'Local host message was already processed.')
      return reply
    }
    return createApiResponse({ serverTime: new Date().toISOString() })
  })

  app.post('/api/agents/:agentId/local-inference/prepare', async (request, reply) => {
    const actor = requireActorContext(request, reply)
    if (!actor || !requireUserActor(actor, reply)) return reply
    const params = parseInput(AgentIdParamsSchema, request.params, reply, 'params')
    const body = parseInput(PrepareLocalInferenceBindingBodySchema, request.body, reply)
    if (!params || !body) return reply
    const agent = await prisma.agent.findFirst({
      where: { id: params.agentId, organizationId: actor.tenant.organizationId, deletedAt: null },
      select: { id: true, organizationId: true, ownerUserId: true, systemManaged: true, visibility: true },
    })
    if (!agent) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Agent not found.')
      return reply
    }
    try {
      await assertAgentEditAuthority(prisma, {
        organizationId: actor.tenant.organizationId,
        uoaIdentity: actor.actionContext.uoaIdentity,
        userId: actor.actor.actorId,
      }, agent)
      const prepared = await prepareLocalInferenceBinding(prisma, {
        agentId: agent.id,
        editorUserId: actor.actor.actorId,
        hostId: body.hostId,
        manifestDigest: body.manifestDigest,
        modelName: body.modelName,
        organizationId: actor.tenant.organizationId,
      })
      reply.header('Cache-Control', 'no-store')
      return createApiResponse({
        bindingId: prepared.bindingId,
        challengeId: prepared.challengeId,
        expiresAt: prepared.expiresAt.toISOString(),
      })
    } catch (error) {
      if (sendBindingError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/local-inference/hosts/:hostId/confirm', async (request, reply) => {
    const params = parseInput(HostIdParamsSchema, request.params, reply, 'params')
    const body = parseInput(ConfirmLocalInferenceBindingBodySchema, request.body, reply)
    if (!params || !body) return reply
    try {
      return createApiResponse(await confirmLocalInferenceBinding(prisma, {
        challengeId: body.challengeId,
        hostId: params.hostId,
        signature: body.signature,
      }))
    } catch (error) {
      if (sendBindingError(reply, error)) return reply
      throw error
    }
  })

  for (const action of ['pause', 'resume', 'revoke'] as const) {
    app.post(`/api/local-inference/hosts/:hostId/${action}`, async (request, reply) => {
      const actor = requireActorContext(request, reply)
      if (!actor || !requireUserActor(actor, reply)) return reply
      const params = parseInput(HostIdParamsSchema, request.params, reply, 'params')
      if (!params) return reply
      const where = {
        custodianUserId: actor.actor.actorId,
        id: params.hostId,
        organizationId: actor.tenant.organizationId,
      }
      const data = action === 'pause'
        ? { pausedAt: new Date() }
        : action === 'resume'
          ? { pausedAt: null }
          : { authorizationRevision: { increment: 1 }, revokedAt: new Date() }
      const updated = await prisma.localInferenceHost.updateMany({ where, data })
      if (updated.count === 0) {
        sendApiError(reply, 404, 'NOT_FOUND', 'Local host not found.')
        return reply
      }
      if (action === 'revoke') {
        await prisma.agentLocalInferenceBinding.updateMany({
          where: { hostId: params.hostId, status: { in: ['active', 'consented_pending_activation', 'pending'] } },
          data: { reason: 'host_revoked', status: 'revoked' },
        })
      }
      return createApiResponse({ ok: true })
    })
  }
}
