import type { FastifyInstance } from 'fastify'

import {
  BlockWorkflowStepRunBodySchema,
  CancelWorkflowRunBodySchema,
  RetryWorkflowRunBodySchema,
  SkipWorkflowStepRunBodySchema,
  UnblockWorkflowStepRunBodySchema,
  WorkflowRunRecordSchema,
  WorkflowStepRunRecordSchema,
} from '../../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import {
  blockWorkflowStepRun,
  cancelWorkflowRun,
  getWorkflowRun,
  retryWorkflowRun,
  skipWorkflowStepRun,
  unblockWorkflowStepRun,
  WorkflowActionError,
} from '../../services/workflows.js'
import type { RouteDeps } from '../types.js'

export const registerWorkflowRunRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner } = deps

  app.get('/api/workflow-runs/:workflowRunId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { workflowRunId } = request.params as { workflowRunId: string }
    const workflowRun = await getWorkflowRun(prisma, actorContext.tenant.organizationId, workflowRunId)
    if (!workflowRun) {
      sendApiError(reply, 404, 'WORKFLOW_RUN_NOT_FOUND', 'Workflow run not found')
      return reply
    }

    return createApiResponse({
      run: WorkflowRunRecordSchema.parse(workflowRun.run),
      steps: WorkflowStepRunRecordSchema.array().parse(workflowRun.steps),
    })
  })

  app.post('/api/workflow-runs/:workflowRunId/cancel', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CancelWorkflowRunBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const { workflowRunId } = request.params as { workflowRunId: string }
    const cancelled = await cancelWorkflowRun(prisma, actorContext, workflowRunId, body)
    if (!cancelled) {
      sendApiError(reply, 404, 'WORKFLOW_RUN_NOT_FOUND', 'Workflow run not found')
      return reply
    }

    return createApiResponse(WorkflowRunRecordSchema.parse(cancelled))
  })

  app.post('/api/workflow-runs/:workflowRunId/retry', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(RetryWorkflowRunBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const { workflowRunId } = request.params as { workflowRunId: string }
    try {
      const retried = await retryWorkflowRun(prisma, actorContext, workflowRunId, body)
      if (!retried) {
        sendApiError(reply, 404, 'WORKFLOW_RUN_NOT_FOUND', 'Workflow run not found')
        return reply
      }
      return reply.code(202).send(createApiResponse(WorkflowRunRecordSchema.parse(retried)))
    } catch (error) {
      if (error instanceof WorkflowActionError) {
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
      throw error
    }
  })

  app.post('/api/workflow-step-runs/:workflowStepRunId/skip', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(SkipWorkflowStepRunBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const { workflowStepRunId } = request.params as { workflowStepRunId: string }
    try {
      const updated = await skipWorkflowStepRun({
        prisma,
        actorContext,
        workflowStepRunId,
        reason: body.reason,
      })
      if (!updated) {
        sendApiError(reply, 404, 'WORKFLOW_STEP_RUN_NOT_FOUND', 'Workflow step run not found')
        return reply
      }
      return createApiResponse(WorkflowStepRunRecordSchema.parse(updated))
    } catch (error) {
      if (error instanceof WorkflowActionError) {
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
      throw error
    }
  })

  app.post('/api/workflow-step-runs/:workflowStepRunId/block', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(BlockWorkflowStepRunBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const { workflowStepRunId } = request.params as { workflowStepRunId: string }
    try {
      const updated = await blockWorkflowStepRun({
        prisma,
        actorContext,
        workflowStepRunId,
        reason: body.reason,
      })
      if (!updated) {
        sendApiError(reply, 404, 'WORKFLOW_STEP_RUN_NOT_FOUND', 'Workflow step run not found')
        return reply
      }
      return createApiResponse(WorkflowStepRunRecordSchema.parse(updated))
    } catch (error) {
      if (error instanceof WorkflowActionError) {
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
      throw error
    }
  })

  app.post('/api/workflow-step-runs/:workflowStepRunId/unblock', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(UnblockWorkflowStepRunBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const { workflowStepRunId } = request.params as { workflowStepRunId: string }
    try {
      const updated = await unblockWorkflowStepRun({
        prisma,
        actorContext,
        workflowStepRunId,
        reason: body.reason,
      })
      if (!updated) {
        sendApiError(reply, 404, 'WORKFLOW_STEP_RUN_NOT_FOUND', 'Workflow step run not found')
        return reply
      }
      return createApiResponse(WorkflowStepRunRecordSchema.parse(updated))
    } catch (error) {
      if (error instanceof WorkflowActionError) {
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
      throw error
    }
  })
}
