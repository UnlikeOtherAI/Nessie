import crypto from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import {
  LOCAL_INFERENCE_ENABLED_SETTING_KEY,
  openLocalInferenceAttempt,
  resolveScopedSetting,
  sealLocalInferenceAttempt,
} from '@nessie/runtime'
import {
  assertLocalInferenceSerializedSize,
  LOCAL_INFERENCE_MAX_FRAME_BYTES,
  LOCAL_INFERENCE_MAX_RESULT_BYTES,
  LOCAL_INFERENCE_MAX_UNACKNOWLEDGED_FRAME_BYTES,
  LocalInferenceHostListSchema,
} from '@nessie/schemas'
import { verifyLocalInferenceEnvelope } from '@nessie/local-inference-host'

import {
  LocalInferenceAttemptFrameRequestSchema,
  LocalInferenceAttemptPollRequestSchema,
  LocalInferenceAttemptResultRequestSchema,
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

  const authenticateDaemonEnvelope = async (input: {
    body: unknown
    envelope: {
      connectionEpoch: string
      executorConnectionEpoch?: string
      hostId: string
      organizationId: string
      purpose: string
      sentAt: string
      sequence: number
    }
    purpose: 'frames' | 'poll' | 'result' | 'goodbye'
  }): Promise<{
    authorization: NonNullable<
      Awaited<ReturnType<typeof authorizeLocalInferenceDaemon>>
    >
    hostId: string
  } | null> => {
    const authorization = await authorizeLocalInferenceDaemon(prisma, input.envelope)
    const host = authorization?.host
    const verified = authorization
      ? verifyLocalInferenceEnvelope({
        body: input.body, envelope: input.envelope, machinePublicKey: authorization.machinePublicKey,
      })
      : { ok: false as const }
    const sentAt = Date.parse(input.envelope.sentAt)
    if (
      !host || !authorization || !verified.ok || input.envelope.purpose !== input.purpose
      || !Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > 30_000
      || BigInt(input.envelope.connectionEpoch) !== BigInt(host.connectionEpoch)
    ) return null
    const accepted = await prisma.$transaction(async (tx) => {
      if (!await executorLocalInferenceDaemonStillAuthorized(tx, authorization)) return false
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`local-inference-host:${host.id}:${input.purpose}`}::text, 0)
        )
      `
      const prior = await tx.localInferenceHostSequence.findUnique({
        where: { hostId_purpose: { hostId: host.id, purpose: input.purpose } },
        select: { lastSequence: true },
      })
      if (prior && prior.lastSequence >= BigInt(input.envelope.sequence)) return false
      await tx.localInferenceHostSequence.upsert({
        where: { hostId_purpose: { hostId: host.id, purpose: input.purpose } },
        create: { hostId: host.id, lastSequence: BigInt(input.envelope.sequence), purpose: input.purpose },
        update: { lastSequence: BigInt(input.envelope.sequence) },
      })
      return true
    })
    return accepted ? { authorization, hostId: host.id } : null
  }

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

  app.post('/api/local-inference/daemon/attempts/poll', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(LocalInferenceAttemptPollRequestSchema, request.body, reply)
    if (!body) return reply
    const daemon = await authenticateDaemonEnvelope({
      body: body.poll, envelope: body.envelope, purpose: 'poll',
    })
    if (!daemon) {
      sendApiError(reply, 404, 'LOCAL_HOST_UNAVAILABLE', 'Local host unavailable.')
      return reply
    }
    const now = new Date()
    const attempt = await prisma.$transaction(async (tx) => {
      if (!daemon.authorization || !await executorLocalInferenceDaemonStillAuthorized(tx, daemon.authorization)) {
        return null
      }
      // Re-read this owner-controlled stop at the leasing boundary. The
      // daemon's envelope was authenticated before the transaction, so a
      // concurrent pause must still win over a queued prompt.
      const active = await tx.localInferenceHost.findFirst({
        where: { id: daemon.hostId, pausedAt: null, revokedAt: null },
        select: { id: true },
      })
      if (!active) return null
      const candidate = await tx.localInferenceAttempt.findFirst({
        where: {
          deadlineAt: { gt: now }, hostId: daemon.hostId,
          OR: [
            { state: 'queued' },
            { leaseExpiresAt: { lt: now }, state: 'leased' },
          ],
        },
        orderBy: { createdAt: 'asc' },
        select: { dispatchFence: true, encryptedRequest: true, id: true, state: true },
      })
      if (!candidate?.encryptedRequest) return null
      const leased = await tx.localInferenceAttempt.updateMany({
        where: {
          id: candidate.id,
          OR: [
            { state: 'queued' },
            { leaseExpiresAt: { lt: now }, state: 'leased' },
          ],
        },
        data: { leaseExpiresAt: new Date(now.getTime() + 60_000), state: 'leased' },
      })
      if (leased.count !== 1) return null
      return {
        dispatchFence: candidate.dispatchFence,
        request: openLocalInferenceAttempt<Record<string, unknown>>(
          deps.encryptionKeyRing,
          candidate.encryptedRequest,
        ),
      }
    })
    return createApiResponse({ attempt: attempt?.request ?? null, dispatchFence: attempt?.dispatchFence ?? null })
  })

  app.post('/api/local-inference/daemon/attempts/frame', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(LocalInferenceAttemptFrameRequestSchema, request.body, reply)
    if (!body) return reply
    const daemon = await authenticateDaemonEnvelope({
      body: body.frame, envelope: body.envelope, purpose: 'frames',
    })
    if (!daemon) {
      sendApiError(reply, 404, 'LOCAL_HOST_UNAVAILABLE', 'Local host unavailable.')
      return reply
    }
    const data = Buffer.from(body.frame.data, 'base64url')
    if (data.byteLength > LOCAL_INFERENCE_MAX_FRAME_BYTES) {
      sendApiError(reply, 400, 'LOCAL_FRAME_TOO_LARGE', 'Local inference frame exceeds its limit.')
      return reply
    }
    const digest = crypto.createHash('sha256').update(data).digest('hex')
    const recorded = await prisma.$transaction(async (tx) => {
      if (!daemon.authorization || !await executorLocalInferenceDaemonStillAuthorized(tx, daemon.authorization)) {
        return 'fenced' as const
      }
      const attempt = await tx.localInferenceAttempt.findFirst({
        where: { id: body.frame.attemptId, hostId: daemon.hostId, state: { in: ['leased', 'accepted'] } },
        select: { dispatchFence: true, id: true },
      })
      if (!attempt || attempt.dispatchFence !== body.frame.dispatchFence) return 'fenced' as const
      const frames = await tx.localInferenceFrame.findMany({
        where: { attemptId: attempt.id, dispatchFence: attempt.dispatchFence },
        select: { encryptedData: true }, take: 9,
      })
      const total = frames.reduce((sum, frame) => sum + frame.encryptedData.byteLength, 0)
      if (frames.length >= 8 || total + data.byteLength > LOCAL_INFERENCE_MAX_UNACKNOWLEDGED_FRAME_BYTES) {
        return 'overflow' as const
      }
      try {
        await tx.localInferenceFrame.create({
          data: {
            attemptId: attempt.id,
            digest,
            dispatchFence: attempt.dispatchFence,
            encryptedData: Uint8Array.from(
              sealLocalInferenceAttempt(deps.encryptionKeyRing, { data: body.frame.data }),
            ),
            sequence: body.frame.sequence,
          },
        })
      } catch {
        const duplicate = await tx.localInferenceFrame.findFirst({
          where: { attemptId: attempt.id, dispatchFence: attempt.dispatchFence, sequence: body.frame.sequence },
          select: { digest: true },
        })
        return duplicate?.digest === digest ? 'duplicate' as const : 'fenced' as const
      }
      return 'recorded' as const
    })
    if (recorded === 'overflow') {
      sendApiError(reply, 409, 'LOCAL_FRAME_OVERFLOW', 'Local inference frame credit is exhausted.')
      return reply
    }
    if (recorded === 'fenced') {
      sendApiError(reply, 409, 'LOCAL_ATTEMPT_FENCED', 'Local inference attempt is no longer current.')
      return reply
    }
    return createApiResponse({ acknowledged: true })
  })

  app.post('/api/local-inference/daemon/attempts/result', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(LocalInferenceAttemptResultRequestSchema, request.body, reply)
    if (!body) return reply
    const daemon = await authenticateDaemonEnvelope({
      body: body.receipt, envelope: body.envelope, purpose: 'result',
    })
    if (!daemon) {
      sendApiError(reply, 404, 'LOCAL_HOST_UNAVAILABLE', 'Local host unavailable.')
      return reply
    }
    if (body.receipt.result.remoteHost !== null || body.receipt.result.remoteModel !== null) {
      sendApiError(reply, 409, 'LOCAL_MODEL_REMOTE', 'Remote Ollama output is not accepted.')
      return reply
    }
    try {
      assertLocalInferenceSerializedSize(body.receipt.result, LOCAL_INFERENCE_MAX_RESULT_BYTES)
    } catch {
      sendApiError(reply, 400, 'LOCAL_RESULT_TOO_LARGE', 'Local inference result exceeds its limit.')
      return reply
    }
    const digest = crypto.createHash('sha256').update(JSON.stringify(body.receipt.result)).digest('hex')
    const completed = await prisma.$transaction(async (tx) => {
      if (!daemon.authorization || !await executorLocalInferenceDaemonStillAuthorized(tx, daemon.authorization)) {
        return false
      }
      const attempt = await tx.localInferenceAttempt.findFirst({
        where: { id: body.receipt.attemptId, hostId: daemon.hostId },
        select: { dispatchFence: true, resultDigest: true, state: true },
      })
      if (!attempt || attempt.dispatchFence !== body.receipt.dispatchFence) return false
      if (attempt.state === 'completed') return attempt.resultDigest === digest
      const updated = await tx.localInferenceAttempt.updateMany({
        where: { id: body.receipt.attemptId, dispatchFence: attempt.dispatchFence, state: { in: ['leased', 'accepted'] } },
        data: {
          encryptedResult: Uint8Array.from(
            sealLocalInferenceAttempt(deps.encryptionKeyRing, body.receipt.result),
          ),
          resultDigest: digest, state: 'completed', terminalAt: new Date(),
        },
      })
      return updated.count === 1
    })
    if (!completed) {
      sendApiError(reply, 409, 'LOCAL_ATTEMPT_FENCED', 'Local inference attempt is no longer current.')
      return reply
    }
    return createApiResponse({ acknowledged: true })
  })

  // An orderly Desktop/executor exit is a signed transition. A delayed
  // goodbye from an old epoch cannot disconnect a replacement connection.
  app.post('/api/local-inference/daemon/goodbye', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(LocalInferenceGoodbyeRequestSchema, request.body, reply)
    if (!body) return reply
    const daemon = await authenticateDaemonEnvelope({
      body: body.goodbye, envelope: body.envelope, purpose: 'goodbye',
    })
    if (!daemon) {
      sendApiError(reply, 404, 'LOCAL_HOST_UNAVAILABLE', 'Local host unavailable.')
      return reply
    }
    const disconnected = await prisma.$transaction(async (tx) => {
      if (!daemon.authorization || !await executorLocalInferenceDaemonStillAuthorized(tx, daemon.authorization)) return false
      const updated = await tx.localInferenceHost.updateMany({
        where: { connectionEpoch: BigInt(body.envelope.connectionEpoch), id: daemon.hostId, revokedAt: null },
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
