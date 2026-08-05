import type { FastifyInstance } from 'fastify'

import { parseAgentId, parseChannelId, parseOrganizationId, parseRunId } from '@nessie/schemas'
import { createApiResponse, sendApiError } from '../lib/api.js'
import {
  continueRun,
  type NotContinuableDetail,
} from '../services/run-continuation.js'
import {
  listActiveRuns,
  listRestartableRuns,
  requestRunCancellation,
  restartRun,
} from '../services/runs.js'
import type { RouteDeps } from './types.js'

// Realtime scopes for a run-status change, mirroring the worker's
// `publishRunUpdated` fan-out (channel + organization + agent) so the admin
// activity views update the same way whether the worker or this route emits.
const runScopes = (organizationId: string, channelId: string, agentId: string) => [
  { kind: 'channel' as const, channelId: parseChannelId(channelId) },
  { kind: 'organization' as const, organizationId: parseOrganizationId(organizationId) },
  { kind: 'agent' as const, agentId: parseAgentId(agentId) },
]

const HANDOFF_CANCEL_HINT =
  'This run is managed by an integration handoff. Cancel it through the product '
  + 'itself (for Deep Water, ask the Personal Assistant to run research_cancel).'

// Why a stopped run has nothing to resume from. All three are the same 409
// code; the message tells the operator which situation they are in.
const NOT_CONTINUABLE_MESSAGE: Record<NotContinuableDetail, string> = {
  input_unavailable: 'The original input for this run is no longer available to replay',
  no_checkpoint: 'This run has no saved working state to continue from',
  not_terminal: 'This run is still active; wait for it to stop before continuing it',
}

export const registerRunRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, realtimeHub, requireActorContext } = deps

  // Org-scoped read of active runs — the "what is running right now / who can I
  // stop" surface (buzz #2453, #1593).
  app.get('/api/runs/active', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const [active, restartable] = await Promise.all([
      listActiveRuns(prisma, actorContext.tenant.organizationId),
      listRestartableRuns(prisma, actorContext.tenant.organizationId),
    ])
    return createApiResponse({ restartable, runs: active })
  })

  // Cooperative, accountable cancel. A queued/approval-suspended run is cancelled
  // immediately; a running run gets a flag the agentic loop honours between
  // iterations and tool-call batches.
  app.post('/api/runs/:runId/cancel', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { runId } = request.params as { runId: string }
    const result = await requestRunCancellation(prisma, {
      cancelledByUserId: actorContext.actor.actorId,
      organizationId: actorContext.tenant.organizationId,
      runId,
    })

    switch (result.kind) {
      case 'not_found':
        sendApiError(reply, 404, 'RUN_NOT_FOUND', 'Run not found')
        return reply
      case 'handoff_managed':
        sendApiError(reply, 409, 'RUN_HANDOFF_MANAGED', HANDOFF_CANCEL_HINT)
        return reply
      case 'already_terminal':
        sendApiError(reply, 409, 'RUN_ALREADY_FINISHED', `Run already ${result.status}`)
        return reply
      case 'cancelled':
        await realtimeHub.publishWs(
          runScopes(actorContext.tenant.organizationId, result.channelId, result.agentId),
          {
            data: {
              agentId: parseAgentId(result.agentId),
              runId: parseRunId(runId),
              status: 'cancelled',
            },
            event: 'run.updated',
          },
        )
        return createApiResponse({ status: 'cancelled' })
      case 'cancel_requested':
        reply.code(202)
        return createApiResponse({ status: 'cancel_requested' })
    }
  })

  // Restart a terminal failed/cancelled run: a fresh run replaying the same input
  // and thread, linked to the original via `restartOfRunId`.
  app.post('/api/runs/:runId/restart', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { runId } = request.params as { runId: string }
    const result = await restartRun(prisma, actorContext, {
      organizationId: actorContext.tenant.organizationId,
      runId,
    })

    switch (result.kind) {
      case 'not_found':
        sendApiError(reply, 404, 'RUN_NOT_FOUND', 'Run not found')
        return reply
      case 'handoff_managed':
        sendApiError(reply, 409, 'RUN_HANDOFF_MANAGED', HANDOFF_CANCEL_HINT)
        return reply
      case 'not_terminal':
        sendApiError(
          reply,
          409,
          'RUN_NOT_TERMINAL',
          `Run is ${result.status}; only a finished run can be restarted`,
        )
        return reply
      case 'not_restartable':
        sendApiError(
          reply,
          409,
          'RUN_NOT_RESTARTABLE',
          `A ${result.status} run cannot be restarted`,
        )
        return reply
      case 'input_unavailable':
        sendApiError(
          reply,
          409,
          'RUN_RESTART_UNAVAILABLE',
          'The original input for this run is no longer available to replay',
        )
        return reply
      case 'thread_busy':
        sendApiError(
          reply,
          409,
          'RUN_THREAD_BUSY',
          'Another run is already active on this thread; wait for it to finish before restarting',
        )
        return reply
      case 'restarted':
        reply.code(201)
        return createApiResponse({
          run: { id: result.runId, restartOfRunId: runId, status: 'pending', taskId: result.taskId },
        })
    }
  })

  // Resume a run that stopped at a policy ceiling, seeding the new run from the
  // stopped run's durable checkpoint. Restart stays available and does not
  // consume the checkpoint; Continue claims it exactly once.
  app.post('/api/runs/:runId/continue', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { runId } = request.params as { runId: string }
    const result = await continueRun(prisma, actorContext, {
      organizationId: actorContext.tenant.organizationId,
      runId,
    })

    switch (result.kind) {
      case 'not_found':
        sendApiError(reply, 404, 'RUN_NOT_FOUND', 'Run not found')
        return reply
      case 'handoff_managed':
        sendApiError(reply, 409, 'RUN_HANDOFF_MANAGED', HANDOFF_CANCEL_HINT)
        return reply
      case 'busy':
        sendApiError(
          reply,
          409,
          'RUN_BUSY',
          'This agent is already running on this thread; wait for it to finish before continuing',
        )
        return reply
      case 'checkpoint_consumed':
        sendApiError(
          reply,
          409,
          'RUN_CHECKPOINT_CONSUMED',
          'This run has already been continued',
        )
        return reply
      case 'not_continuable':
        sendApiError(
          reply,
          409,
          'RUN_NOT_CONTINUABLE',
          NOT_CONTINUABLE_MESSAGE[result.detail],
        )
        return reply
      case 'continued':
        return createApiResponse({ runId: result.runId })
    }
  })
}
