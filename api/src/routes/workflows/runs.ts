import type { FastifyInstance } from 'fastify'

import {
  BlockWorkflowStepRunBodySchema,
  WorkflowListQuerySchema,
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
  skipWorkflowStepRun,
  unblockWorkflowStepRun,
} from '../../services/workflow-run-controls.js'
import { getWorkflowRun, listWorkflowRuns, retryWorkflowRun } from '../../services/workflow-runs.js'
import { WorkflowActionError } from '../../services/workflow-validation.js'
import { auditWorkflowMutation } from '../../services/workflow-audit.js'
import {
  canActorReadWorkflowInstallation,
  isWorkflowAdmin,
  workflowInstallationEntitlementFilter,
} from '../../services/workflow-entitlement.js'
import type { RouteDeps } from '../types.js'

/** W19: cancel/retry/skip/block/unblock mutate a run or the in-flight graph;
 *  the plan's matrix keeps mutations admin-or-owner (pause/uninstall row)
 *  except manual start, which lives on the installation routes. */
const requireWorkflowAdmin = (
  actorContext: Parameters<typeof isWorkflowAdmin>[0],
  reply: Parameters<typeof sendApiError>[0],
): boolean => {
  if (isWorkflowAdmin(actorContext)) {
    return true
  }
  sendApiError(reply, 403, 'FORBIDDEN', 'Workflow admin access required')
  return false
}

/** Read gate for a run: the actor must be entitled to the run's installation
 *  scope. Returns false (after sending 404) when not. */
const requireWorkflowRunReadAccess = async (
  prisma: Parameters<typeof canActorReadWorkflowInstallation>[0],
  actorContext: Parameters<typeof isWorkflowAdmin>[0],
  workflowRunId: string,
  reply: Parameters<typeof sendApiError>[0],
): Promise<boolean> => {
  const run = await prisma.workflowRun.findFirst({
    where: { id: workflowRunId, organizationId: actorContext.tenant.organizationId },
    select: { installationId: true },
  })
  if (!run || !(await canActorReadWorkflowInstallation(prisma, actorContext, run.installationId))) {
    sendApiError(reply, 404, 'WORKFLOW_RUN_NOT_FOUND', 'Workflow run not found')
    return false
  }
  return true
}

export const registerWorkflowRunRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext } = deps

  // W29: cross-installation "what failed" feed. Entitlement-scoped exactly
  // like the per-installation runs list — a member sees failures on
  // installations their channels cover, nothing else.
  app.get('/api/workflow-runs', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const query = parseInput(WorkflowListQuerySchema, request.query ?? {}, reply)
    if (!query) {
      return reply
    }

    const installationWhere =
      (await workflowInstallationEntitlementFilter(prisma, actorContext)) ?? undefined
    const page = await listWorkflowRuns(prisma, actorContext.tenant.organizationId, {
      cursor: query.cursor,
      limit: query.limit,
      ...(query.status ? { status: query.status } : {}),
      ...(installationWhere ? { installationWhere } : {}),
    })
    return createApiResponse(WorkflowRunRecordSchema.array().parse(page.data), page.meta)
  })

  app.get('/api/workflow-runs/:workflowRunId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { workflowRunId } = request.params as { workflowRunId: string }
    // W19: any member entitled to the installation's scope reads the run
    // (W0 redaction in getWorkflowRun covers the widened readership).
    if (!(await requireWorkflowRunReadAccess(prisma, actorContext, workflowRunId, reply))) {
      return reply
    }
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
    if (!requireWorkflowAdmin(actorContext, reply)) {
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

    await auditWorkflowMutation(prisma, actorContext, {
      action: 'workflow.run.cancelled',
      metadata: { ...(body.reason ? { reason: body.reason } : {}) },
      resourceId: cancelled.id,
      resourceType: 'workflow_run',
      status: cancelled.status,
    })

    return createApiResponse(WorkflowRunRecordSchema.parse(cancelled))
  })

  app.post('/api/workflow-runs/:workflowRunId/retry', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireWorkflowAdmin(actorContext, reply)) {
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
      // W22: the audit actor is the retrying caller even though the new run
      // keeps its original starter (W27) — history and the log each tell the
      // truth about a different thing.
      await auditWorkflowMutation(prisma, actorContext, {
        action: 'workflow.run.retried',
        metadata: {
          retriedFromWorkflowRunId: workflowRunId,
          ...(body.reason ? { reason: body.reason } : {}),
        },
        resourceId: retried.id,
        resourceType: 'workflow_run',
        status: retried.status,
      })
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
    if (!requireWorkflowAdmin(actorContext, reply)) {
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
      await auditWorkflowMutation(prisma, actorContext, {
        action: 'workflow.step_run.skipped',
        metadata: { ...(body.reason ? { reason: body.reason } : {}) },
        resourceId: updated.id,
        resourceType: 'workflow_step_run',
        status: updated.status,
      })
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
    if (!requireWorkflowAdmin(actorContext, reply)) {
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
      await auditWorkflowMutation(prisma, actorContext, {
        action: 'workflow.step_run.blocked',
        metadata: { ...(body.reason ? { reason: body.reason } : {}) },
        resourceId: updated.id,
        resourceType: 'workflow_step_run',
        status: updated.status,
      })
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
    if (!requireWorkflowAdmin(actorContext, reply)) {
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
      await auditWorkflowMutation(prisma, actorContext, {
        action: 'workflow.step_run.unblocked',
        metadata: { ...(body.reason ? { reason: body.reason } : {}) },
        resourceId: updated.id,
        resourceType: 'workflow_step_run',
        status: updated.status,
      })
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
