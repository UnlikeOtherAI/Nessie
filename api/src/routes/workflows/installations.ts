import type { FastifyInstance } from 'fastify'

import {
  AgentTriggerRecordSchema,
  CreateWorkflowRunBodySchema,
  CreateWorkflowTriggerBodySchema,
  InstallWorkflowTemplateBodySchema,
  UpdateWorkflowInstallationBodySchema,
  WorkflowInstallationRecordSchema,
  WorkflowListQuerySchema,
  WorkflowRunRecordSchema,
} from '../../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import { createWorkflowTrigger, listWorkflowInstallationTriggers } from '../../services/triggers.js'
import {
  createWorkflowRun,
  installWorkflowTemplate,
  listWorkflowInstallations,
  listWorkflowRuns,
  updateWorkflowInstallation,
  WorkflowInstallationLifecycleError,
  WorkflowSecretWriteError,
} from '../../services/workflows.js'
import type { RouteDeps } from '../types.js'

const sendWorkflowSecretWriteError = (
  reply: Parameters<typeof sendApiError>[0],
  error: WorkflowSecretWriteError,
): void => {
  const detail = error.violations
    .map((violation) => `${violation.path}: ${violation.reason}`)
    .join('; ')
  sendApiError(
    reply,
    400,
    'WORKFLOW_BINDING_SECRET_INVALID',
    `Workflow bindings/config cannot store caller-supplied secrets — ${detail}`,
  )
}

export const registerWorkflowInstallationRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    requireActorContext,
    requireOwner,
    isWorkflowInstallationAccessibleToActor,
  } = deps

  app.post('/api/workflows/:workflowTemplateId/install', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(InstallWorkflowTemplateBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { workflowTemplateId } = request.params as { workflowTemplateId: string }
    let installation
    try {
      installation = await installWorkflowTemplate(
        prisma,
        actorContext,
        workflowTemplateId,
        body,
      )
    } catch (error) {
      if (error instanceof WorkflowSecretWriteError) {
        sendWorkflowSecretWriteError(reply, error)
        return reply
      }
      if (error instanceof WorkflowInstallationLifecycleError) {
        sendApiError(
          reply,
          409,
          'WORKFLOW_INSTALLATION_STATUS_CONFLICT',
          'active and status describe different states; send one consistent lifecycle',
        )
        return reply
      }
      if (error instanceof Error && error.message === 'WORKFLOW_INSTALLATION_CHANNEL_NOT_FOUND') {
        sendApiError(
          reply,
          404,
          'WORKFLOW_INSTALLATION_CHANNEL_NOT_FOUND',
          'Workflow installation channel not found',
        )
        return reply
      }
      throw error
    }

    if (!installation) {
      sendApiError(reply, 404, 'WORKFLOW_TEMPLATE_NOT_FOUND', 'Workflow template not found')
      return reply
    }

    return reply
      .code(201)
      .send(createApiResponse(WorkflowInstallationRecordSchema.parse(installation)))
  })

  app.get('/api/workflow-installations', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const query = parseInput(WorkflowListQuerySchema, request.query ?? {}, reply)
    if (!query) {
      return reply
    }

    const page = await listWorkflowInstallations(
      prisma,
      actorContext.tenant.organizationId,
      query,
    )
    return createApiResponse(
      WorkflowInstallationRecordSchema.array().parse(page.items),
      { cursor: page.nextCursor, hasMore: page.nextCursor !== null },
    )
  })

  // W8: pause / resume / disable / re-target. Status was write-once at
  // install; this is the update endpoint that makes `paused` reachable.
  app.patch('/api/workflow-installations/:installationId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(UpdateWorkflowInstallationBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { installationId } = request.params as { installationId: string }
    let installation
    try {
      installation = await updateWorkflowInstallation(
        prisma,
        actorContext,
        installationId,
        body,
      )
    } catch (error) {
      if (error instanceof WorkflowSecretWriteError) {
        sendWorkflowSecretWriteError(reply, error)
        return reply
      }
      if (error instanceof WorkflowInstallationLifecycleError) {
        sendApiError(
          reply,
          409,
          'WORKFLOW_INSTALLATION_STATUS_CONFLICT',
          'active and status describe different states; send one consistent lifecycle',
        )
        return reply
      }
      if (error instanceof Error && error.message === 'WORKFLOW_INSTALLATION_CHANNEL_NOT_FOUND') {
        sendApiError(
          reply,
          404,
          'WORKFLOW_INSTALLATION_CHANNEL_NOT_FOUND',
          'Workflow installation channel not found',
        )
        return reply
      }
      throw error
    }

    if (!installation) {
      sendApiError(reply, 404, 'WORKFLOW_INSTALLATION_NOT_FOUND', 'Workflow installation not found')
      return reply
    }

    return createApiResponse(WorkflowInstallationRecordSchema.parse(installation))
  })

  app.post('/api/workflow-installations/:installationId/run', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreateWorkflowRunBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { installationId } = request.params as { installationId: string }
    let workflowRun
    try {
      workflowRun = await createWorkflowRun(prisma, actorContext, installationId, body)
    } catch (error) {
      if (error instanceof Error) {
        const workflowRunErrorMap: Record<string, { code: string; message: string }> = {
          WORKFLOW_RUN_PARENT_RUN_NOT_FOUND: {
            code: 'WORKFLOW_RUN_PARENT_RUN_NOT_FOUND',
            message: 'Parent run not found',
          },
          WORKFLOW_RUN_PLAN_NOT_FOUND: {
            code: 'WORKFLOW_RUN_PLAN_NOT_FOUND',
            message: 'Plan not found',
          },
          WORKFLOW_RUN_PLAN_STEP_MISMATCH: {
            code: 'WORKFLOW_RUN_PLAN_STEP_MISMATCH',
            message: 'Plan step does not belong to the requested plan',
          },
          WORKFLOW_RUN_PLAN_STEP_NOT_FOUND: {
            code: 'WORKFLOW_RUN_PLAN_STEP_NOT_FOUND',
            message: 'Plan step not found',
          },
          WORKFLOW_RUN_TRIGGER_DELIVERY_MISMATCH: {
            code: 'WORKFLOW_RUN_TRIGGER_DELIVERY_MISMATCH',
            message: 'Trigger delivery does not belong to the requested trigger',
          },
          WORKFLOW_RUN_TRIGGER_DELIVERY_NOT_FOUND: {
            code: 'WORKFLOW_RUN_TRIGGER_DELIVERY_NOT_FOUND',
            message: 'Trigger delivery not found',
          },
          WORKFLOW_RUN_TRIGGER_NOT_FOUND: {
            code: 'WORKFLOW_RUN_TRIGGER_NOT_FOUND',
            message: 'Trigger not found',
          },
        }
        const mapped = workflowRunErrorMap[error.message]
        if (mapped) {
          sendApiError(reply, 404, mapped.code, mapped.message)
          return reply
        }
      }
      throw error
    }

    if (!workflowRun) {
      sendApiError(
        reply,
        404,
        'WORKFLOW_INSTALLATION_NOT_FOUND',
        'Workflow installation not found or inactive',
      )
      return reply
    }

    return reply.code(202).send(createApiResponse(WorkflowRunRecordSchema.parse(workflowRun)))
  })

  app.get('/api/workflow-installations/:installationId/runs', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const query = parseInput(WorkflowListQuerySchema, request.query ?? {}, reply)
    if (!query) {
      return reply
    }

    const { installationId } = request.params as { installationId: string }
    const page = await listWorkflowRuns(prisma, actorContext.tenant.organizationId, {
      ...query,
      installationId,
    })
    return createApiResponse(
      WorkflowRunRecordSchema.array().parse(page.items),
      { cursor: page.nextCursor, hasMore: page.nextCursor !== null },
    )
  })

  app.get('/api/workflow-installations/:installationId/triggers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { installationId } = request.params as { installationId: string }
    if (!(await isWorkflowInstallationAccessibleToActor(actorContext, installationId))) {
      sendApiError(reply, 404, 'WORKFLOW_INSTALLATION_NOT_FOUND', 'Workflow installation not found')
      return reply
    }

    const triggers = await listWorkflowInstallationTriggers(prisma, installationId)
    return createApiResponse(AgentTriggerRecordSchema.array().parse(triggers))
  })

  app.post('/api/workflow-installations/:installationId/triggers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { installationId } = request.params as { installationId: string }
    if (!(await isWorkflowInstallationAccessibleToActor(actorContext, installationId))) {
      sendApiError(reply, 404, 'WORKFLOW_INSTALLATION_NOT_FOUND', 'Workflow installation not found')
      return reply
    }

    const body = parseInput(CreateWorkflowTriggerBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const trigger = await createWorkflowTrigger(prisma, installationId, body)
    if (!trigger) {
      sendApiError(reply, 400, 'TRIGGER_INVALID', 'Trigger configuration is invalid')
      return reply
    }

    return reply.code(201).send(createApiResponse(AgentTriggerRecordSchema.parse(trigger)))
  })
}
