import type { FastifyInstance } from 'fastify'

import {
  ActiveRunRecordSchema,
  SteerRunBodySchema,
} from '@nessie/schemas'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  getActiveRun,
  enqueueSteerInstruction,
  cancelActiveRun,
  listActiveRuns,
} from '../../../worker/src/run/execute.js'
import type { RouteDeps } from './types.js'

export const registerRunRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { requireActorContext } = deps

  // GET /api/runs — list all active runs with metadata
  app.get('/api/runs', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const runs = listActiveRuns()
    return createApiResponse(
      ActiveRunRecordSchema.array().parse(
        runs.map((run) => ({
          runId: run.runId,
          agentId: run.agentId,
          threadId: run.threadId,
          status: run.status,
          startedAt: run.startedAt,
          tokenUsage: run.tokenUsage,
          steerQueueLength: run.steerQueueLength,
        })),
      ),
    )
  })

  // POST /api/runs/:id/cancel — gracefully stop a run
  app.post('/api/runs/:runId/cancel', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { runId } = request.params as { runId: string }
    const entry = getActiveRun(runId)
    if (!entry) {
      sendApiError(reply, 404, 'RUN_NOT_FOUND', 'Active run not found')
      return reply
    }

    const cancelled = cancelActiveRun(runId)
    if (!cancelled) {
      sendApiError(reply, 409, 'RUN_ALREADY_TERMINAL', 'Run is already terminal')
      return reply
    }

    return createApiResponse({ ok: true, runId })
  })

  // POST /api/runs/:id/steer — enqueue a mid-run instruction
  app.post('/api/runs/:runId/steer', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(SteerRunBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const { runId } = request.params as { runId: string }
    const entry = getActiveRun(runId)
    if (!entry) {
      sendApiError(reply, 404, 'RUN_NOT_FOUND', 'Active run not found')
      return reply
    }

    const enqueued = enqueueSteerInstruction(runId, body.instruction)
    if (!enqueued) {
      sendApiError(reply, 409, 'RUN_NOT_ACTIVE', 'Run is no longer active')
      return reply
    }

    return createApiResponse({ ok: true, runId, instruction: body.instruction })
  })
}
