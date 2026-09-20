import { authorizeExecutorDaemonControlCall } from '@nessie/executor-manage'
import type { FastifyInstance } from 'fastify'

import {
  LocalInferenceExecutorHostBodySchema,
  LocalInferenceExecutorHostSchema,
} from '../contracts/local-inference.js'
import { createApiResponse, parseInput } from '../lib/api.js'
import { sendExecutorError } from './executor-route-errors.js'
import type { RouteDeps } from './types.js'

/**
 * A paired executor owns exactly one host record. The executor's own pairing
 * fixes its organization and custodian, so this daemon doorway has no knobs
 * that could fabricate either from a browser or an untrusted local process.
 */
export const registerLocalInferenceExecutorHostRoute = (
  app: FastifyInstance,
  { prisma }: RouteDeps,
): void => {
  app.post('/api/local-inference/daemon/executor-host', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(LocalInferenceExecutorHostBodySchema, request.body, reply)
    if (!body) return reply
    try {
      const host = await authorizeExecutorDaemonControlCall(
        prisma,
        {
          connectionEpoch: body.connectionEpoch,
          executorId: body.executorId,
          observedAt: body.observedAt,
          payload: {
            connectionEpoch: body.connectionEpoch,
            executorId: body.executorId,
            observedAt: body.observedAt,
          },
          signature: body.signature,
          type: 'local_inference.host',
        },
        async (tx) => {
          const executor = await tx.executor.findUnique({
            where: { id: body.executorId },
            select: { id: true, organizationId: true, pairingOwnerUserId: true },
          })
          if (!executor) throw new Error('Authorized executor disappeared.')
          const existing = await tx.localInferenceHost.findUnique({
            where: { executorId: executor.id },
            select: { connectionEpoch: true, custodianUserId: true, id: true, organizationId: true, revokedAt: true },
          })
          if (existing) {
            // Custody cannot drift when a key is reconnected. A revoked local
            // host remains revoked until the owner makes a fresh pairing; the
            // daemon cannot turn an explicit server-side revoke into a resume.
            if (
              existing.revokedAt
              || existing.organizationId !== executor.organizationId
              || existing.custodianUserId !== executor.pairingOwnerUserId
            ) throw new Error('Local inference host is unavailable.')
            return {
              connectionEpoch: String(existing.connectionEpoch),
              hostId: existing.id,
              organizationId: existing.organizationId,
            }
          }
          const created = await tx.localInferenceHost.create({
            data: {
              custodianUserId: executor.pairingOwnerUserId,
              displayLabel: 'Paired executor',
              executorId: executor.id,
              organizationId: executor.organizationId,
              transport: 'executor',
            },
            select: { connectionEpoch: true, id: true, organizationId: true },
          })
          return {
            connectionEpoch: String(created.connectionEpoch),
            hostId: created.id,
            organizationId: created.organizationId,
          }
        },
      )
      return createApiResponse(LocalInferenceExecutorHostSchema.parse(host))
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })
}
