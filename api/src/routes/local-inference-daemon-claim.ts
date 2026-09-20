import crypto from 'node:crypto'

import type { FastifyInstance, FastifyReply } from 'fastify'
import { verifyLocalInferenceEnvelope } from '@nessie/local-inference-host'

import {
  LocalInferenceDaemonChallengeBodySchema,
  LocalInferenceDaemonChallengeSchema,
  LocalInferenceDaemonClaimBodySchema,
  LocalInferenceDaemonConnectionSchema,
} from '../contracts/local-inference.js'
import { createApiResponse, sendApiError } from '../lib/api.js'
import {
  authorizeLocalInferenceDaemon,
  executorLocalInferenceDaemonStillAuthorized,
} from '../services/local-inference-daemon-auth.js'
import type { RouteDeps } from './types.js'

const challengeDigest = (challenge: string): string => crypto.createHash('sha256')
  .update(challenge)
  .digest('hex')

const daemonUnavailable = (reply: FastifyReply) => {
  // This is intentionally one response for unknown, revoked, replayed and
  // unauthenticated hosts. Any distinction would be a device/tenant oracle.
  sendApiError(reply, 404, 'LOCAL_HOST_UNAVAILABLE', 'Local host unavailable.')
  return reply
}

/** Public only in the transport sense: both routes require the host key. */
export const registerLocalInferenceDaemonClaimRoutes = (
  app: FastifyInstance,
  { prisma }: RouteDeps,
): void => {
  app.post('/api/local-inference/daemon/challenge', { config: { public: true } }, async (request, reply) => {
    // A malformed body is not distinguishable from an unknown host.  `parseInput`
    // would turn this into a validation oracle before we even reach the host
    // lookup, which is exactly what this public pairing doorway must avoid.
    const parsed = LocalInferenceDaemonChallengeBodySchema.safeParse(request.body)
    if (!parsed.success) return daemonUnavailable(reply)
    const body = parsed.data
    const host = await prisma.localInferenceHost.findFirst({
      where: { id: body.hostId, revokedAt: null },
      select: { connectionEpoch: true, id: true, organizationId: true },
    })
    if (!host) return daemonUnavailable(reply)
    const challenge = crypto.randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + 60_000)
    await prisma.localInferenceChallenge.create({
      data: {
        connectionEpoch: host.connectionEpoch,
        digest: challengeDigest(challenge),
        expiresAt,
        hostId: host.id,
        organizationId: host.organizationId,
        purpose: 'daemon',
        subjectDigest: challengeDigest(`host:${host.id}:${host.connectionEpoch}`),
      },
    })
    reply.header('Cache-Control', 'no-store')
    return createApiResponse(LocalInferenceDaemonChallengeSchema.parse({
      challenge, expiresAt: expiresAt.toISOString(),
    }))
  })

  app.post('/api/local-inference/daemon/claim', { config: { public: true } }, async (request, reply) => {
    const parsed = LocalInferenceDaemonClaimBodySchema.safeParse(request.body)
    if (!parsed.success) return daemonUnavailable(reply)
    const body = parsed.data
    const authorization = await authorizeLocalInferenceDaemon(prisma, body.envelope)
    const host = authorization?.host
    const verified = authorization
      ? verifyLocalInferenceEnvelope({
        body: { challenge: body.challenge }, envelope: body.envelope, machinePublicKey: authorization.machinePublicKey,
      })
      : { ok: false as const }
    const sentAt = Date.parse(body.envelope.sentAt)
    if (
      !host || !authorization || !verified.ok || body.envelope.purpose !== 'claim'
      || !Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > 30_000
      || BigInt(body.envelope.connectionEpoch) !== BigInt(host.connectionEpoch)
    ) return daemonUnavailable(reply)
    const nextEpoch = await prisma.$transaction(async (tx) => {
      if (!await executorLocalInferenceDaemonStillAuthorized(tx, authorization)) return null
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`local-inference-host:${host.id}:claim`}::text, 0))
      `
      const consumed = await tx.localInferenceChallenge.updateMany({
        where: {
          connectionEpoch: host.connectionEpoch, consumedAt: null,
          digest: challengeDigest(body.challenge), expiresAt: { gt: new Date() },
          hostId: host.id, purpose: 'daemon',
        },
        data: { consumedAt: new Date() },
      })
      if (consumed.count !== 1) return null
      const advanced = await tx.localInferenceHost.updateMany({
        where: { connectionEpoch: host.connectionEpoch, id: host.id, revokedAt: null },
        data: { connectionEpoch: { increment: 1 }, lastSeenAt: null },
      })
      if (advanced.count !== 1) return null
      await tx.localInferenceHostSequence.deleteMany({ where: { hostId: host.id } })
      return host.connectionEpoch + 1
    })
    if (nextEpoch === null) return daemonUnavailable(reply)
    return createApiResponse(LocalInferenceDaemonConnectionSchema.parse({
      connectionEpoch: String(nextEpoch), serverTime: new Date().toISOString(),
    }))
  })
}
