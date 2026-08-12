import type { FastifyInstance } from 'fastify'

import {
  CreateWorkflowTemplateBodySchema,
  RecordWorkflowStepSamplesBodySchema,
  RecordWorkflowStepSamplesResultSchema,
  UpdateWorkflowTemplateBodySchema,
  WorkflowListQuerySchema,
  WorkflowStepSamplesRecordSchema,
  WorkflowTemplateRecordSchema,
} from '../../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import {
  getWorkflowTemplateStepSamples,
  recordWorkflowStepSamples,
  WorkflowStepSamplesError,
} from '../../services/workflow-step-samples.js'
import {
  createWorkflowTemplate,
  getWorkflowTemplate,
  listWorkflowTemplates,
  updateWorkflowTemplate,
  WorkflowTemplateValidationError,
} from '../../services/workflows.js'
import type { FastifyReply } from 'fastify'
import type { RouteDeps } from '../types.js'

/**
 * Shared 4xx mapping for template create/update: step-validation problems are
 * a 400 with every issue listed so the designer can show them verbatim.
 */
const sendTemplateSaveError = (reply: FastifyReply, error: unknown): boolean => {
  if (error instanceof WorkflowTemplateValidationError) {
    sendApiError(reply, 400, 'WORKFLOW_TEMPLATE_INVALID', error.issues.join(' '))
    return true
  }

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
    return true
  }

  return false
}

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

    const query = parseInput(WorkflowListQuerySchema, request.query ?? {}, reply)
    if (!query) {
      return reply
    }

    const page = await listWorkflowTemplates(prisma, actorContext.tenant.organizationId, query)
    return createApiResponse(
      WorkflowTemplateRecordSchema.array().parse(page.items),
      { cursor: page.nextCursor, hasMore: page.nextCursor !== null },
    )
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
      if (sendTemplateSaveError(reply, error)) {
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
      if (sendTemplateSaveError(reply, error)) {
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
  // §5 stepSamples — owner-gated on both sides: the store is served only to
  // the role that can already read the template's bindings, and written only
  // by that same role after a designer test run completes.
  app.get('/api/workflows/:workflowTemplateId/step-samples', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { workflowTemplateId } = request.params as { workflowTemplateId: string }
    const samples = await getWorkflowTemplateStepSamples(
      prisma,
      actorContext.tenant.organizationId,
      workflowTemplateId,
    )
    if (!samples) {
      sendApiError(reply, 404, 'WORKFLOW_STEP_SAMPLES_NOT_FOUND', 'No step samples for this template')
      return reply
    }

    return createApiResponse(WorkflowStepSamplesRecordSchema.parse(samples))
  })

  app.post('/api/workflows/:workflowTemplateId/step-samples', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(RecordWorkflowStepSamplesBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { workflowTemplateId } = request.params as { workflowTemplateId: string }
    try {
      const result = await recordWorkflowStepSamples(
        prisma,
        actorContext.tenant.organizationId,
        {
          stepOutputs: body.stepOutputs,
          workflowInstallationId: body.workflowInstallationId,
          workflowRunId: body.workflowRunId,
          workflowTemplateId,
        },
      )
      return createApiResponse(RecordWorkflowStepSamplesResultSchema.parse({ result }))
    } catch (error) {
      if (error instanceof WorkflowStepSamplesError) {
        sendApiError(reply, 404, error.message, 'Workflow template or installation not found')
        return reply
      }
      throw error
    }
  })

}
