import { notifyExecutorStatus } from './executor-status-events.js'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { countRateLimitHit, rateLimitKeyHash } from '@nessie/db'
import {
  claimExecutorCodePairing, decideExecutorCodePairing, pollExecutorCodePairing,
  previewExecutorCodePairing, readExecutorPairingConnection, startExecutorCodePairing,
} from '@nessie/executor-manage'
import {
  ExecutorPairingStartRequestSchema, ExecutorPairingStartResponseSchema,
  ExecutorPairingPollRequestSchema, ExecutorPairingPollResponseSchema,
  ExecutorPairingDecisionRequestSchema, ExecutorPairingConnectionRequestSchema,
  ExecutorPairingClaimSchema, ExecutorPairingPreviewRequestSchema, ExecutorPairingPreviewSchema,
  ExecutorPairingClaimRequestSchema, ExecutorPairingClaimResponseSchema, ExecutorPairingOptionsSchema,
} from '@nessie/schemas'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { executorPairingNames, pairingAuthorityForActor } from '../services/executor-pairing-identity.js'
import { executorPairingAudit as audit } from '../services/executor-pairing-audit.js'
import { canonicalizeIpIdentity } from '../services/rate-limit-identity.js'
import { notifyExecutorLeaseChanges } from './executor-leases.js'
import { sendExecutorError } from './executor-route-errors.js'
import type { RouteDeps } from './types.js'

export const registerExecutorPairingCodeRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma } = deps
  const names = (executor: Parameters<typeof executorPairingNames>[1]) => executorPairingNames(prisma, executor)
  // Eight digits need a shared, fail-CLOSED limiter. The general-purpose
  // limiter intentionally fails open, so this uses its atomic DB store directly.
  const guard = async (
    ip: string, kind: 'mint' | 'lookup' | 'machine', reply: FastifyReply, userId?: string,
  ): Promise<boolean> => {
    const bucket = `executor.pairing.${kind}`
    const rule = { max: kind === 'mint' ? 5 : kind === 'lookup' ? 10 : 120, windowMs: kind === 'machine' ? 60_000 : 600_000 }
    try {
      const identities = [`ip:${canonicalizeIpIdentity(ip)}`, ...(userId ? [`account:${userId}`] : [])]
      const decisions = await Promise.all(identities.map((identity) => countRateLimitHit(prisma, {
        bucket, keyHash: rateLimitKeyHash(bucket, identity), rule,
      })))
      const blocked = decisions.find((decision) => decision.limited)
      if (!blocked) return true
      reply.header('Retry-After', blocked.retryAfterSeconds)
      sendApiError(reply, 429, 'EXECUTOR_PAIRING_RATE_LIMITED', 'Too many attempts. Please wait before trying again.')
    } catch {
      sendApiError(reply, 503, 'EXECUTOR_PAIRING_UNAVAILABLE', 'Pairing is temporarily unavailable. Please try again.')
    }
    return false
  }
  const fail = (reply: FastifyReply, error: unknown) => {
    if (sendExecutorError(reply, error)) return reply
    throw error
  }

  app.get('/api/executor-pairing/options', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    try {
      const authority = await pairingAuthorityForActor(prisma, actor)
      return createApiResponse(ExecutorPairingOptionsSchema.parse(authority.options))
    } catch (error) { return fail(reply, error) }
  })
  app.post('/api/executor-pairing/preview', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    if (!await guard(request.ip, 'lookup', reply, actor.actor.actorId)) return reply
    const body = parseInput(ExecutorPairingPreviewRequestSchema, request.body, reply)
    if (!body) return reply
    try {
      await pairingAuthorityForActor(prisma, actor)
      return createApiResponse(ExecutorPairingPreviewSchema.parse(
        await previewExecutorCodePairing(prisma, deps.authSecret, body.code),
      ))
    } catch (error) { return fail(reply, error) }
  })
  app.post('/api/executor-pairing/claim', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    if (!await guard(request.ip, 'lookup', reply, actor.actor.actorId)) return reply
    const body = parseInput(ExecutorPairingClaimRequestSchema, request.body, reply)
    if (!body) return reply
    try {
      const authority = await pairingAuthorityForActor(prisma, actor)
      const result = await claimExecutorCodePairing(
        prisma, deps.authSecret, ExecutorPairingClaimRequestSchema.parse(body), authority, audit,
      )
      await notifyExecutorStatus(deps, request.log, result.executorId)
      return createApiResponse(ExecutorPairingClaimResponseSchema.parse(result))
    } catch (error) { return fail(reply, error) }
  })
  app.post('/api/executor-pairing/start', { config: { public: true } }, async (request, reply) => {
    if (!await guard(request.ip, 'mint', reply)) return reply
    const body = parseInput(ExecutorPairingStartRequestSchema, request.body, reply)
    if (!body) return reply
    try {
      // Pairing again revokes the machine's previous executor row, which ends
      // its conversation leases; their holders are told after the commit.
      const result = await startExecutorCodePairing(
        prisma, deps.authSecret, body, audit, undefined,
        (leases) => notifyExecutorLeaseChanges(deps, request.log, leases),
      )
      if (body.replacesExecutorId) await notifyExecutorStatus(deps, request.log, body.replacesExecutorId)
      return createApiResponse(ExecutorPairingStartResponseSchema.parse(result))
    } catch (error) { return fail(reply, error) }
  })
  app.post('/api/executor-pairing/poll', { config: { public: true } }, async (request, reply) => {
    if (!await guard(request.ip, 'machine', reply)) return reply
    const body = parseInput(ExecutorPairingPollRequestSchema, request.body, reply)
    if (!body) return reply
    try {
      return createApiResponse(ExecutorPairingPollResponseSchema.parse(
        await pollExecutorCodePairing(prisma, body, names),
      ))
    } catch (error) { return fail(reply, error) }
  })
  for (const action of ['confirm', 'reject', 'cancel'] as const) {
    app.post(`/api/executor-pairing/${action}`, { config: { public: true } }, async (request, reply) => {
      if (!await guard(request.ip, 'machine', reply)) return reply
      const body = action === 'cancel'
        ? parseInput(ExecutorPairingPollRequestSchema, request.body, reply)
        : parseInput(ExecutorPairingDecisionRequestSchema, request.body, reply)
      if (!body) return reply
      try {
        const result = await decideExecutorCodePairing(prisma, body, action, names, audit)
        if (result.claim) await notifyExecutorStatus(deps, request.log, result.claim.executorId)
        return createApiResponse(ExecutorPairingPollResponseSchema.parse(result))
      } catch (error) { return fail(reply, error) }
    })
  }
  app.post('/api/executor-pairing/connection', { config: { public: true } }, async (request, reply) => {
    if (!await guard(request.ip, 'machine', reply)) return reply
    const body = parseInput(ExecutorPairingConnectionRequestSchema, request.body, reply)
    if (!body) return reply
    try {
      return createApiResponse(ExecutorPairingClaimSchema.parse(
        await readExecutorPairingConnection(prisma, body, names),
      ))
    } catch (error) { return fail(reply, error) }
  })
}
