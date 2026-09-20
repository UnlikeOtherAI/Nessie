import type { FastifyInstance } from 'fastify'
import { LocalInferenceHostListSchema } from '@nessie/schemas'
import { verifyLocalInferenceEnvelope } from '@nessie/local-inference-host'

import {
  LocalInferenceGoodbyeRequestSchema,
  LocalInferenceConsentDisplayRequestSchema,
  LocalInferenceHeartbeatRequestSchema,
} from '../contracts/local-inference.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  authorizeLocalInferenceDaemon,
  executorLocalInferenceDaemonStillAuthorized,
} from '../services/local-inference-daemon-auth.js'
import { registerLocalInferenceDaemonClaimRoutes } from './local-inference-daemon-claim.js'
import { registerLocalInferenceConsentRoutes } from './local-inference-consent-routes.js'
import { registerLocalInferenceExecutorHostRoute } from './local-inference-executor-host.js'
import { registerLocalInferenceDesktopEnrollmentRoute } from './local-inference-desktop-enrollment.js'
import { registerLocalInferenceAttemptRoutes } from './local-inference-attempt-routes.js'
import { authenticateLocalInferenceDaemonEnvelope } from '../services/local-inference-daemon-intake.js'
import type { RouteDeps } from './types.js'

/** Owner-host-only surfaces. Browser sessions may list/select their own host;
 * native daemon confirmation remains signature-proven and cannot be replaced
 * with a session cookie. The status projection is intentionally derived from
 * current host and binding facts, never a browser-maintained cache. */
export const registerLocalInferenceRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps
  registerLocalInferenceDaemonClaimRoutes(app, deps)
  registerLocalInferenceExecutorHostRoute(app, deps)
  registerLocalInferenceConsentRoutes(app, deps)
  registerLocalInferenceDesktopEnrollmentRoute(app, deps)
  registerLocalInferenceAttemptRoutes(app, deps)
  // The native dialog fetches its own text through a machine-signed, one-use
  // challenge capability. This is deliberately public only in transport terms:
  // a browser session, deep link, or copied challenge cannot read or choose the
  // displayed identity/model fields without the enrolled host private key.
  app.post('/api/local-inference/consent-display', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(LocalInferenceConsentDisplayRequestSchema, request.body, reply)
    if (!body) return reply
    const authorization = await authorizeLocalInferenceDaemon(prisma, body.envelope)
    const verified = authorization ? verifyLocalInferenceEnvelope({
      body: { challengeId: body.challengeId },
      envelope: body.envelope, machinePublicKey: authorization.machinePublicKey,
    }) : { ok: false as const }
    if (!authorization || !verified.ok || body.envelope.purpose !== 'consent_display'
      || authorization.host.id !== body.envelope.hostId) {
      sendApiError(reply, 404, 'LOCAL_HOST_UNAVAILABLE', 'Local host unavailable.')
      return reply
    }
    const challenge = await prisma.localInferenceChallenge.findFirst({
      where: {
        consumedAt: null, expiresAt: { gt: new Date() }, hostId: authorization.host.id,
        id: body.challengeId, organizationId: authorization.host.organizationId, purpose: 'binding',
      },
      select: { bindingId: true },
    })
    if (!challenge?.bindingId) {
      sendApiError(reply, 404, 'LOCAL_HOST_UNAVAILABLE', 'Local host unavailable.')
      return reply
    }
    const [binding, host, organization] = await Promise.all([
      prisma.agentLocalInferenceBinding.findUnique({
        where: { id: challenge.bindingId },
        select: { agentId: true, modelName: true, preparedEditorUserId: true },
      }),
      prisma.localInferenceHost.findUnique({
        where: { id: authorization.host.id }, select: { displayLabel: true },
      }),
      prisma.organization.findUnique({
        where: { id: authorization.host.organizationId }, select: { externalOrgId: true },
      }),
    ])
    if (!binding || !host || !organization || !binding.preparedEditorUserId) {
      sendApiError(reply, 404, 'LOCAL_HOST_UNAVAILABLE', 'Local host unavailable.')
      return reply
    }
    const [agent, editor] = await Promise.all([
      prisma.agent.findUnique({ where: { id: binding.agentId }, select: { name: true } }),
      prisma.user.findUnique({ where: { id: binding.preparedEditorUserId }, select: { id: true, uoaSub: true } }),
    ])
    if (!agent || !editor) {
      sendApiError(reply, 404, 'LOCAL_HOST_UNAVAILABLE', 'Local host unavailable.')
      return reply
    }
    reply.header('Cache-Control', 'no-store')
    return createApiResponse({
      accountReference: editor.uoaSub ?? editor.id,
      agentLabel: agent.name,
      hostLabel: host.displayLabel,
      modelLabel: binding.modelName,
      organizationReference: organization.externalOrgId ?? authorization.host.organizationId,
      bindingId: challenge.bindingId,
      hostId: authorization.host.id,
    })
  })

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
        executorId: true, id: true, inventory: true, inventoryObservedAt: true, lastSeenAt: true,
        pausedAt: true, revokedAt: true, transport: true,
      },
    })
    const bindings = rows.length === 0 ? [] : await prisma.agentLocalInferenceBinding.findMany({
      where: {
        hostId: { in: rows.map((host) => host.id) },
        organizationId: actor.tenant.organizationId,
        status: { not: 'revoked' },
      },
      select: { hostId: true, status: true },
    })
    const statusPriority = {
      active: 4,
      consented_pending_activation: 3,
      needs_rebinding: 2,
      pending: 1,
    } as const
    const bindingStatus = new Map<string, keyof typeof statusPriority>()
    for (const binding of bindings) {
      // Prisma's enum type keeps `revoked` even though the query excludes it.
      // Do not let a type assertion turn a future query change into an invalid
      // status projection.
      if (binding.status === 'revoked') continue
      const current = bindingStatus.get(binding.hostId)
      if (!current || statusPriority[binding.status] > statusPriority[current]) {
        bindingStatus.set(binding.hostId, binding.status)
      }
    }
    const now = Date.now()
    return createApiResponse(LocalInferenceHostListSchema.parse({
      hosts: rows.map((host) => ({
        availability: host.revokedAt || host.pausedAt || !host.lastSeenAt || now - host.lastSeenAt.getTime() > 60_000
          ? 'offline' : 'online',
        canonicalSocket: null,
        executorId: host.executorId,
        id: host.id,
        lastSeenAt: host.lastSeenAt?.toISOString() ?? null,
        models: Array.isArray(host.inventory) ? host.inventory : [],
        paused: host.pausedAt !== null,
        status: host.revokedAt ? 'revoked' : bindingStatus.get(host.id) ?? 'unconfigured',
        transport: host.transport,
      })),
      meta: { hasMore: false, nextCursor: null, prevCursor: null, total: rows.length },
    }))
  })

  // A host may advertise only a signed, bounded observation of its own local
  // Ollama. This route has no user-session substitute: a copied browser cookie
  // cannot extend a device lease or publish an inventory.
  app.post('/api/local-inference/daemon/heartbeat', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(LocalInferenceHeartbeatRequestSchema, request.body, reply)
    if (!body) return reply
    const authorization = await authorizeLocalInferenceDaemon(prisma, body.envelope)
    const host = authorization?.host
    const verified = authorization
      ? verifyLocalInferenceEnvelope({
          body: body.heartbeat,
          envelope: body.envelope,
          machinePublicKey: authorization.machinePublicKey,
        })
      : { ok: false as const }
    const sentAt = Date.parse(body.envelope.sentAt)
    const fresh = Number.isFinite(sentAt) && Math.abs(Date.now() - sentAt) <= 30_000
    if (
      !host || !authorization
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
      if (!await executorLocalInferenceDaemonStillAuthorized(tx, authorization)) return false
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
          // A device may always pause itself, including while it is offline.
          // Only the custodian's explicit resume route clears that pause: an
          // old or restarted daemon claiming `paused: false` cannot silently
          // reverse the owner's decision.
          ...(body.heartbeat.paused ? { pausedAt: new Date() } : {}),
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

  // An orderly Desktop/executor exit is a signed transition. A delayed
  // goodbye from an old epoch cannot disconnect a replacement connection.
  app.post('/api/local-inference/daemon/goodbye', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(LocalInferenceGoodbyeRequestSchema, request.body, reply)
    if (!body) return reply
    const daemon = await authenticateLocalInferenceDaemonEnvelope(prisma, {
      body: body.goodbye, envelope: body.envelope, purpose: 'goodbye',
    })
    if (!daemon) {
      sendApiError(reply, 404, 'LOCAL_HOST_UNAVAILABLE', 'Local host unavailable.')
      return reply
    }
    const disconnected = await prisma.$transaction(async (tx) => {
      if (!await daemon.stillAuthorized(tx)) return false
      const updated = await tx.localInferenceHost.updateMany({
        where: { connectionEpoch: Number(body.envelope.connectionEpoch), id: daemon.hostId, revokedAt: null },
        data: { lastSeenAt: null },
      })
      return updated.count === 1
    })
    if (!disconnected) {
      sendApiError(reply, 409, 'LOCAL_HOST_FENCED', 'Local host is no longer current.')
      return reply
    }
    return createApiResponse({ acknowledged: true })
  })

}
