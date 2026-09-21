import crypto from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import { claimLocalInferenceAttemptAdmission, openLocalInferenceAttempt, sealLocalInferenceAttempt } from '@nessie/runtime'
import {
  LOCAL_INFERENCE_MAX_FRAME_BYTES,
  LOCAL_INFERENCE_MAX_RESULT_BYTES,
  LOCAL_INFERENCE_MAX_UNACKNOWLEDGED_FRAME_BYTES,
  assertLocalInferenceSerializedSize,
} from '@nessie/schemas'

import {
  LocalInferenceAttemptControlRequestSchema,
  LocalInferenceAttemptFrameRequestSchema,
  LocalInferenceAttemptPollRequestSchema,
  LocalInferenceAttemptResultRequestSchema,
} from '../contracts/local-inference.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { authenticateLocalInferenceDaemonEnvelope } from '../services/local-inference-daemon-intake.js'
import { controlLocalInferenceAttempt } from '../services/local-inference-attempt-control.js'
import type { RouteDeps } from './types.js'

export const registerLocalInferenceAttemptRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma } = deps

  app.post('/api/local-inference/daemon/attempts/poll', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(LocalInferenceAttemptPollRequestSchema, request.body, reply)
    if (!body) return reply
    const daemon = await authenticateLocalInferenceDaemonEnvelope(prisma, {
      body: body.poll, envelope: body.envelope, purpose: 'poll',
    })
    if (!daemon) return unavailable(reply)
    const now = new Date()
    const attempt = await prisma.$transaction(async (tx) => {
      if (!await daemon.stillAuthorized(tx)) return null
      const active = await tx.localInferenceHost.findFirst({
        where: { id: daemon.hostId, pausedAt: null, revokedAt: null }, select: { id: true, inferenceResourceId: true },
      })
      if (!active?.inferenceResourceId) return null
      await tx.localInferenceAttempt.updateMany({
        where: { deadlineAt: { lte: now }, hostId: daemon.hostId, state: { in: ['queued', 'leased', 'accepted'] } },
        data: { failureReason: 'deadline_exceeded', state: 'expired', terminalAt: now },
      })
      const candidates = await tx.localInferenceAttempt.findMany({
        where: {
          deadlineAt: { gt: now }, hostId: daemon.hostId,
          OR: [{ state: 'queued' }, { leaseExpiresAt: { lt: now }, state: 'leased' }],
        },
        orderBy: { createdAt: 'asc' },
        select: { dispatchFence: true, encryptedRequest: true, id: true, runId: true, resourceAdmissionId: true },
        take: 100,
      })
      for (const candidate of candidates) {
        if (!candidate.encryptedRequest || candidate.resourceAdmissionId) continue
        const admission = await claimLocalInferenceAttemptAdmission(tx, {
          attemptId: candidate.id, resourceId: active.inferenceResourceId, runId: candidate.runId,
        })
        if (admission.kind !== 'admitted') continue
        const leased = await tx.localInferenceAttempt.updateMany({
          where: { id: candidate.id, OR: [{ state: 'queued' }, { leaseExpiresAt: { lt: now }, state: 'leased' }] },
          data: { leaseExpiresAt: new Date(now.getTime() + 60_000), state: 'leased' },
        })
        if (leased.count !== 1) throw new Error('Inference attempt changed while its resource was locked.')
        return {
          admission: admission.admission,
          dispatchFence: candidate.dispatchFence,
          request: openLocalInferenceAttempt<Record<string, unknown>>(
            deps.encryptionKeyRing, candidate.encryptedRequest,
          ),
        }
      }
      return null
    })
    return createApiResponse({
      admission: attempt?.admission ?? null, attempt: attempt?.request ?? null,
      dispatchFence: attempt?.dispatchFence ?? null,
    })
  })

  app.post('/api/local-inference/daemon/attempts/control', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(LocalInferenceAttemptControlRequestSchema, request.body, reply)
    if (!body) return reply
    const daemon = await authenticateLocalInferenceDaemonEnvelope(prisma, {
      body: body.control, envelope: body.envelope, purpose: 'control',
    })
    if (!daemon) return unavailable(reply)
    const state = await prisma.$transaction((tx) => controlLocalInferenceAttempt({
      attemptId: body.control.attemptId,
      dispatchFence: body.control.dispatchFence,
      hostId: daemon.hostId,
      now: new Date(),
      stillAuthorized: () => daemon.stillAuthorized(tx),
      tx,
    }))
    return createApiResponse({ state })
  })

  app.post('/api/local-inference/daemon/attempts/frame', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(LocalInferenceAttemptFrameRequestSchema, request.body, reply)
    if (!body) return reply
    const daemon = await authenticateLocalInferenceDaemonEnvelope(prisma, {
      body: body.frame, envelope: body.envelope, purpose: 'frames',
    })
    if (!daemon) return unavailable(reply)
    const data = Buffer.from(body.frame.data, 'base64url')
    if (data.byteLength > LOCAL_INFERENCE_MAX_FRAME_BYTES) {
      sendApiError(reply, 400, 'LOCAL_FRAME_TOO_LARGE', 'Local inference frame exceeds its limit.')
      return reply
    }
    const digest = crypto.createHash('sha256').update(data).digest('hex')
    const recorded = await prisma.$transaction(async (tx) => {
      if (!await daemon.stillAuthorized(tx)) return 'fenced' as const
      const attempt = await tx.localInferenceAttempt.findFirst({
        where: { id: body.frame.attemptId, hostId: daemon.hostId, state: { in: ['leased', 'accepted'] } },
        select: { dispatchFence: true, id: true },
      })
      if (!attempt || attempt.dispatchFence !== body.frame.dispatchFence) return 'fenced' as const
      const frames = await tx.localInferenceFrame.findMany({
        where: { acknowledgedAt: null, attemptId: attempt.id, dispatchFence: attempt.dispatchFence },
        select: { encryptedData: true }, take: 9,
      })
      const total = frames.reduce((sum, frame) => sum + frame.encryptedData.byteLength, 0)
      if (frames.length >= 8 || total + data.byteLength > LOCAL_INFERENCE_MAX_UNACKNOWLEDGED_FRAME_BYTES) return 'overflow' as const
      try {
        await tx.localInferenceFrame.create({
          data: {
            attemptId: attempt.id, digest, dispatchFence: attempt.dispatchFence,
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
    const daemon = await authenticateLocalInferenceDaemonEnvelope(prisma, {
      body: body.receipt, envelope: body.envelope, purpose: 'result',
    })
    if (!daemon) return unavailable(reply)
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
      if (!await daemon.stillAuthorized(tx)) return false
      const attempt = await tx.localInferenceAttempt.findFirst({
        where: { id: body.receipt.attemptId, hostId: daemon.hostId },
        select: { deadlineAt: true, dispatchFence: true, modelDigest: true, resultDigest: true, state: true },
      })
      if (!attempt || attempt.dispatchFence !== body.receipt.dispatchFence) return false
      if (attempt.state === 'completed') return attempt.resultDigest === digest
      const expired = attempt.deadlineAt <= new Date()
      if (expired || attempt.modelDigest !== body.receipt.result.modelDigest) {
        await tx.localInferenceAttempt.updateMany({
          where: { id: body.receipt.attemptId, state: { in: ['queued', 'leased', 'accepted'] } },
          data: { failureReason: expired ? 'deadline_exceeded' : 'model_digest_mismatch', state: expired ? 'expired' : 'failed', terminalAt: new Date() },
        })
        return false
      }
      const updated = await tx.localInferenceAttempt.updateMany({
        where: { id: body.receipt.attemptId, deadlineAt: { gt: new Date() }, dispatchFence: attempt.dispatchFence, state: { in: ['leased', 'accepted'] } },
        data: {
          encryptedResult: Uint8Array.from(sealLocalInferenceAttempt(deps.encryptionKeyRing, body.receipt.result)),
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
}

const unavailable = (reply: Parameters<typeof sendApiError>[0]) => {
  sendApiError(reply, 404, 'LOCAL_HOST_UNAVAILABLE', 'Local host unavailable.')
  return reply
}
