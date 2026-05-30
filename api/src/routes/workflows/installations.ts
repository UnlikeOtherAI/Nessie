import type { FastifyInstance } from 'fastify'

import {
  AgentTriggerRecordSchema,
  CreateWorkflowRunBodySchema,
  CreateWorkflowTriggerBodySchema,
  InstallWorkflowTemplateBodySchema,
  WorkflowInstallationRecordSchema,
  WorkflowRunRecordSchema,
} from '../../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import { createWorkflowTrigger, listWorkflowInstallationTriggers } from '../../services/triggers.js'
import {
  createWorkflowRun,
  installWorkflowTemplate,
  listWorkflowInstallations,
  listWorkflowRuns,
} from '../../services/workflows.js'
import type { RouteDeps } from '../types.js'

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

    const installations = await listWorkflowInstallations(
      prisma,
      actorContext.tenant.organizationId,
    )
    return createApiResponse(WorkflowInstallationRecordSchema.array().parse(installations))
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

    const { installationId } = request.params as { installationId: string }
    const runs = await listWorkflowRuns(prisma, actorContext.tenant.organizationId, {
      installationId,
    })
    return createApiResponse(WorkflowRunRecordSchema.array().parse(runs))
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
