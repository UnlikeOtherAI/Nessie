import {
  claimExecutorConnection,
  pollAuthorizedExecutorCommand,
  recordAuthorizedExecutorCommandReceipt,
  recordExecutorDaemonChallenge,
  reportExecutorHeartbeat,
  submitExecutorDescriptor,
  submitExecutorEnrollment,
} from '@nessie/executor-manage'
import type { FastifyInstance } from 'fastify'

import {
  ExecutorDaemonChallengeBodySchema,
  ExecutorDaemonChallengeSchema,
  ExecutorDaemonClaimBodySchema,
  ExecutorDaemonConnectionSchema,
  ExecutorDaemonDescriptorBodySchema,
  ExecutorDaemonDescriptorSchema,
  ExecutorDaemonCommandPollBodySchema,
  ExecutorDaemonCommandPollSchema,
  ExecutorDaemonCommandReceiptBodySchema,
  ExecutorDaemonHeartbeatBodySchema,
  PendingExecutorEnrollmentSchema,
  SubmitExecutorEnrollmentBodySchema,
} from '../contracts/executors.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { issueExecutorDaemonChallenge, verifyExecutorDaemonChallenge } from '../services/executor-daemon-auth.js'
import { sendExecutorError } from './executor-route-errors.js'
import type { RouteDeps } from './types.js'

/** Public daemon handoff routes, isolated from browser-side executor management. */
export const registerExecutorDaemonRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma } = deps
  app.post(
    '/api/executor-daemon/challenge',
    { config: { public: true } },
    async (request, reply) => {
      // Rate limiting is the global hook's: `/api/executor-daemon/challenge`
      // is paired with `executorDaemonIp` in `POST_ROUTE_BUCKETS`, like the
      // other six daemon routes, so all seven pair in one table.
      const body = parseInput(ExecutorDaemonChallengeBodySchema, request.body, reply)
      if (!body) return reply
      const challenge = issueExecutorDaemonChallenge(body.executorId, deps.authSecret)
      await recordExecutorDaemonChallenge(prisma, {
        challenge: challenge.challenge,
        executorId: body.executorId,
        expiresAt: new Date(challenge.expiresAt),
      })
      return createApiResponse(ExecutorDaemonChallengeSchema.parse(challenge))
    },
  )

  app.post(
    '/api/executor-daemon/claim',
    { config: { public: true } },
    async (request, reply) => {
      const body = parseInput(ExecutorDaemonClaimBodySchema, request.body, reply)
      if (!body) return reply
      if (!verifyExecutorDaemonChallenge(body.challenge, body.executorId, deps.authSecret)) {
        sendApiError(reply, 401, 'EXECUTOR_DAEMON_CHALLENGE_INVALID', 'Executor challenge is invalid.')
        return reply
      }
      try {
        const connection = await claimExecutorConnection(prisma, body)
        return createApiResponse(ExecutorDaemonConnectionSchema.parse(connection))
      } catch (error) {
        if (sendExecutorError(reply, error)) return reply
        throw error
      }
    },
  )

  app.post(
    '/api/executor-daemon/heartbeat',
    { config: { public: true } },
    async (request, reply) => {
      const body = parseInput(ExecutorDaemonHeartbeatBodySchema, request.body, reply)
      if (!body) return reply
      try {
        const connection = await reportExecutorHeartbeat(prisma, body)
        return createApiResponse(ExecutorDaemonConnectionSchema.parse(connection))
      } catch (error) {
        if (sendExecutorError(reply, error)) return reply
        throw error
      }
    },
  )

  app.post(
    '/api/executor-daemon/descriptor',
    { config: { public: true } },
    async (request, reply) => {
      const body = parseInput(ExecutorDaemonDescriptorBodySchema, request.body, reply)
      if (!body) return reply
      try {
        const result = await submitExecutorDescriptor(prisma, body)
        return createApiResponse(ExecutorDaemonDescriptorSchema.parse(result))
      } catch (error) {
        if (sendExecutorError(reply, error)) return reply
        throw error
      }
    },
  )

  app.post(
    '/api/executor-daemon/commands/poll',
    { config: { public: true } },
    async (request, reply) => {
      const body = parseInput(ExecutorDaemonCommandPollBodySchema, request.body, reply)
      if (!body) return reply
      try {
        const command = await pollAuthorizedExecutorCommand(prisma, deps.encryptionKeyRing, body)
        return createApiResponse(ExecutorDaemonCommandPollSchema.parse({ command }))
      } catch (error) {
        if (sendExecutorError(reply, error)) return reply
        throw error
      }
    },
  )

  app.post(
    '/api/executor-daemon/commands/receipt',
    { config: { public: true } },
    async (request, reply) => {
      const body = parseInput(ExecutorDaemonCommandReceiptBodySchema, request.body, reply)
      if (!body) return reply
      try {
        await recordAuthorizedExecutorCommandReceipt(prisma, deps.encryptionKeyRing, body)
        return createApiResponse({ recorded: true })
      } catch (error) {
        if (sendExecutorError(reply, error)) return reply
        throw error
      }
    },
  )

  app.post(
    '/api/executor-enrollments/submit',
    { config: { public: true } },
    async (request, reply) => {
      const body = parseInput(SubmitExecutorEnrollmentBodySchema, request.body, reply)
      if (!body) return reply
      try {
        const pending = await submitExecutorEnrollment(prisma, body)
        return createApiResponse(PendingExecutorEnrollmentSchema.parse(pending))
      } catch (error) {
        if (sendExecutorError(reply, error)) return reply
        throw error
      }
    },
  )
}
