import type { FastifyInstance, FastifyBaseLogger } from 'fastify'
import {
  endExecutorConversationLease,
  publishExecutorLeaseChanges,
  type ExecutorLeaseRef,
} from '@nessie/executor-manage'
import {
  ExecutorConversationLeaseRecordSchema,
  ExecutorLeaseEndResponseSchema,
  ExecutorLeaseListQuerySchema,
  ExecutorMachineLeaseRecordSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { listExecutorMachineLeases, listOwnExecutorConversationLeases } from '../services/executor-lease-reads.js'
import { sendExecutorError } from './executor-route-errors.js'
import type { RouteDeps } from './types.js'

const UuidSchema = z.string().uuid()

/**
 * Change notices go out after the change has committed, so a failed notice
 * must not turn a durable launch, End or access change into an error the
 * client would retry. The holder's next read or the indicator's own expiry
 * refetch still converges.
 */
export const notifyExecutorLeaseChanges = async (
  deps: Pick<RouteDeps, 'realtimeHub'>,
  log: FastifyBaseLogger,
  leases: readonly ExecutorLeaseRef[],
): Promise<void> => {
  if (leases.length === 0) return
  try {
    await publishExecutorLeaseChanges(deps.realtimeHub, leases)
  } catch (error) {
    log.error({ err: error, leaseIds: leases.map((lease) => lease.id) }, '[executor-leases] change notice failed')
  }
}

/**
 * Where a person sees and ends the conversation leases that let their own
 * follow-ups keep local apps (docs/plans/2026-09-22-executor-local-apps/
 * conversation-lease.md §4): the composer's holder-only indicator reads the
 * first route, and the executor detail page's live-lease list the third.
 */
export const registerExecutorLeaseRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  app.get('/api/executor-leases', async (request, reply) => {
    const actor = requireActorContext(request, reply)
    if (!actor || !requireUserActor(actor, reply)) return reply
    const query = parseInput(ExecutorLeaseListQuerySchema, request.query, reply, 'query')
    if (!query) return reply
    const leases = await listOwnExecutorConversationLeases(prisma, actor, query)
    return createApiResponse(ExecutorConversationLeaseRecordSchema.array().parse(leases))
  })

  app.post('/api/executor-leases/:leaseId/end', async (request, reply) => {
    const actor = requireActorContext(request, reply)
    if (!actor || !requireUserActor(actor, reply)) return reply
    const leaseId = UuidSchema.safeParse((request.params as { leaseId?: string }).leaseId)
    if (!leaseId.success) {
      sendApiError(reply, 404, 'EXECUTOR_NOT_FOUND', 'Executor lease not found.')
      return reply
    }
    try {
      const result = await endExecutorConversationLease(prisma, actor, { leaseId: leaseId.data })
      if (result.ended) await notifyExecutorLeaseChanges(deps, request.log, [result.lease])
      return createApiResponse(ExecutorLeaseEndResponseSchema.parse({
        ended: result.ended,
        leaseId: result.lease.id,
      }))
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/executors/:executorId/leases', async (request, reply) => {
    const actor = requireActorContext(request, reply)
    if (!actor || !requireUserActor(actor, reply)) return reply
    const executorId = UuidSchema.safeParse((request.params as { executorId?: string }).executorId)
    if (!executorId.success) {
      sendApiError(reply, 404, 'EXECUTOR_NOT_FOUND', 'Executor not found')
      return reply
    }
    try {
      const leases = await listExecutorMachineLeases(prisma, actor, executorId.data)
      return createApiResponse(ExecutorMachineLeaseRecordSchema.array().parse(leases))
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })
}
