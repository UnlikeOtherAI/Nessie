import type { FastifyInstance } from 'fastify'

import {
  CreateWorkflowTemplateBodySchema,
  UpdateWorkflowTemplateBodySchema,
  WorkflowTemplateRecordSchema,
} from '../../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import {
  createWorkflowTemplate,
  getWorkflowTemplate,
  listWorkflowTemplates,
  updateWorkflowTemplate,
} from '../../services/workflows.js'
import type { RouteDeps } from '../types.js'

export const registerWorkflowTemplateRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner } = deps

  app.get('/api/workflows', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const workflows = await listWorkflowTemplates(prisma, actorContext.tenant.organizationId)
    return createApiResponse(WorkflowTemplateRecordSchema.array().parse(workflows))
  })

  app.post('/api/workflows', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreateWorkflowTemplateBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    let workflow
    try {
      workflow = await createWorkflowTemplate(prisma, actorContext, body)
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'WORKFLOW_TEMPLATE_ENVIRONMENT_TEMPLATE_NOT_FOUND'
      ) {
        sendApiError(
          reply,
          404,
          'WORKFLOW_TEMPLATE_ENVIRONMENT_TEMPLATE_NOT_FOUND',
          'One or more required execution environment templates were not found',
        )
        return reply
      }
      throw error
    }

    return reply.code(201).send(createApiResponse(WorkflowTemplateRecordSchema.parse(workflow)))
  })

  app.get('/api/workflows/:workflowTemplateId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { workflowTemplateId } = request.params as { workflowTemplateId: string }
    const workflow = await getWorkflowTemplate(
      prisma,
      actorContext.tenant.organizationId,
      workflowTemplateId,
    )
    if (!workflow) {
      sendApiError(reply, 404, 'WORKFLOW_TEMPLATE_NOT_FOUND', 'Workflow template not found')
      return reply
    }

    return createApiResponse(WorkflowTemplateRecordSchema.parse(workflow))
  })

  app.put('/api/workflows/:workflowTemplateId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(UpdateWorkflowTemplateBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { workflowTemplateId } = request.params as { workflowTemplateId: string }
    let workflow
    try {
      workflow = await updateWorkflowTemplate(
        prisma,
        actorContext,
        workflowTemplateId,
        body,
      )
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'WORKFLOW_TEMPLATE_ENVIRONMENT_TEMPLATE_NOT_FOUND'
      ) {
        sendApiError(
          reply,
          404,
          'WORKFLOW_TEMPLATE_ENVIRONMENT_TEMPLATE_NOT_FOUND',
          'One or more required execution environment templates were not found',
        )
        return reply
      }
      throw error
    }

    if (!workflow) {
      sendApiError(reply, 404, 'WORKFLOW_TEMPLATE_NOT_FOUND', 'Workflow template not found')
      return reply
    }

    return createApiResponse(WorkflowTemplateRecordSchema.parse(workflow))
  })
}
