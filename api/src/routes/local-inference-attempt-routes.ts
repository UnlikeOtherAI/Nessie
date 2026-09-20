import crypto from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { openLocalInferenceAttempt, sealLocalInferenceAttempt } from '@nessie/runtime'
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
import type { RouteDeps } from './types.js'

const RETENTION_MS = 60 * 60_000

const sweepExpiredTransport = async (tx: Prisma.TransactionClient, now: Date): Promise<void> => {
  const cutoff = new Date(now.getTime() - RETENTION_MS)
  const terminal = await tx.localInferenceAttempt.findMany({
    where: { terminalAt: { lte: cutoff } }, select: { id: true }, take: 200,
  })
  await tx.localInferenceFrame.deleteMany({
    where: {
      OR: [
        { acknowledgedAt: { lte: cutoff } },
        ...(terminal.length ? [{ attemptId: { in: terminal.map((attempt) => attempt.id) } }] : []),
      ],
    },
  })
  if (terminal.length) {
    await tx.localInferenceAttempt.deleteMany({ where: { id: { in: terminal.map((attempt) => attempt.id) } } })
  }
}

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
      await sweepExpiredTransport(tx, now)
      const active = await tx.localInferenceHost.findFirst({
        where: { id: daemon.hostId, pausedAt: null, revokedAt: null }, select: { id: true },
      })
      if (!active) return null
      await tx.localInferenceAttempt.updateMany({
        where: { deadlineAt: { lte: now }, hostId: daemon.hostId, state: { in: ['queued', 'leased', 'accepted'] } },
        data: { failureReason: 'deadline_exceeded', state: 'expired', terminalAt: now },
      })
      const candidate = await tx.localInferenceAttempt.findFirst({
        where: {
          deadlineAt: { gt: now }, hostId: daemon.hostId,
          OR: [{ state: 'queued' }, { leaseExpiresAt: { lt: now }, state: 'leased' }],
        },
        orderBy: { createdAt: 'asc' },
        select: { dispatchFence: true, encryptedRequest: true, id: true },
      })
      if (!candidate?.encryptedRequest) return null
      const leased = await tx.localInferenceAttempt.updateMany({
        where: { id: candidate.id, OR: [{ state: 'queued' }, { leaseExpiresAt: { lt: now }, state: 'leased' }] },
        data: { leaseExpiresAt: new Date(now.getTime() + 60_000), state: 'leased' },
      })
      if (leased.count !== 1) return null
      return {
        dispatchFence: candidate.dispatchFence,
        request: openLocalInferenceAttempt<Record<string, unknown>>(deps.encryptionKeyRing, candidate.encryptedRequest),
      }
    })
    return createApiResponse({ attempt: attempt?.request ?? null, dispatchFence: attempt?.dispatchFence ?? null })
  })

  app.post('/api/local-inference/daemon/attempts/control', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(LocalInferenceAttemptControlRequestSchema, request.body, reply)
    if (!body) return reply
    const daemon = await authenticateLocalInferenceDaemonEnvelope(prisma, {
      body: body.control, envelope: body.envelope, purpose: 'control',
    })
    if (!daemon) return unavailable(reply)
    const state = await prisma.$transaction(async (tx) => {
      if (!await daemon.stillAuthorized(tx)) return 'fenced' as const
      const attempt = await tx.localInferenceAttempt.findFirst({
        where: { id: body.control.attemptId, hostId: daemon.hostId },
        select: { deadlineAt: true, dispatchFence: true, state: true },
      })
      if (!attempt || attempt.dispatchFence !== body.control.dispatchFence) return 'fenced' as const
      if (attempt.state === 'cancelled') return 'cancelled' as const
      if (attempt.state === 'completed' || attempt.state === 'failed' || attempt.state === 'expired') return 'fenced' as const
      if (attempt.deadlineAt <= new Date()) {
        await tx.localInferenceAttempt.updateMany({
          where: { id: body.control.attemptId, state: { in: ['queued', 'leased', 'accepted'] } },
          data: { failureReason: 'deadline_exceeded', state: 'expired', terminalAt: new Date() },
        })
        return 'expired' as const
      }
      const now = new Date()
      await tx.localInferenceAttempt.updateMany({
        where: {
          id: body.control.attemptId,
          dispatchFence: body.control.dispatchFence,
          state: { in: ['leased', 'accepted'] },
        },
        data: {
          acceptedAt: attempt.state === 'leased' ? now : undefined,
          leaseExpiresAt: new Date(now.getTime() + 60_000),
          state: 'accepted',
        },
      })
      return 'active' as const
    })
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
            encryptedData: Uint8Array.from(sealLocalInferenceAttempt(deps.encryptionKeyRing, { data: body.frame.data })),
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
