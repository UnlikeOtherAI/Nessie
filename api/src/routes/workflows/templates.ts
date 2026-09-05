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
  readIfMatchRevision,
  sendMalformedIfMatch,
  sendRevisionConflict,
} from '../../lib/if-match.js'
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
  WorkflowTemplateVersionConflictError,
} from '../../services/workflow-templates.js'
import {
  WORKFLOW_REFERENCE_ERROR_CODES,
  WorkflowReferenceError,
} from '../../services/workflow-references.js'
import { WorkflowTemplateValidationError } from '../../services/workflow-validation.js'
import { auditWorkflowMutation } from '@nessie/team-admin'
import { isWorkflowAdmin } from '../../services/workflow-entitlement.js'
import type { FastifyReply } from 'fastify'
import type { RouteDeps } from '../types.js'

/** W19: authoring/editing/publishing a template is org admin-or-owner; the
 *  step-samples store follows the template gate exactly (it is served only to
 *  the role that can already read the template's bindings). */
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

/**
 * Shared 4xx mapping for template create/update: step-validation problems are
 * a 400 with every issue listed so the designer can show them verbatim.
 */
const sendTemplateSaveError = (reply: FastifyReply, error: unknown): boolean => {
  if (error instanceof WorkflowTemplateValidationError) {
    sendApiError(reply, 400, 'WORKFLOW_TEMPLATE_INVALID', error.issues.join(' '))
    return true
  }

  // Thrown as the typed `WorkflowReferenceError` by `@nessie/team-admin`'s
  // `workflow-authoring.ts` (create/update template) — matched on `.code`,
  // not on message text.
  if (
    error instanceof WorkflowReferenceError &&
    error.code === WORKFLOW_REFERENCE_ERROR_CODES.TEMPLATE_ENVIRONMENT_TEMPLATE_NOT_FOUND
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
  const { prisma, requireActorContext } = deps

  app.get('/api/workflows', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireWorkflowAdmin(actorContext, reply)) {
      return reply
    }

    const query = parseInput(WorkflowListQuerySchema, request.query ?? {}, reply)
    if (!query) {
      return reply
    }

    const page = await listWorkflowTemplates(prisma, actorContext.tenant.organizationId, query)
    return createApiResponse(WorkflowTemplateRecordSchema.array().parse(page.data), page.meta)
  })

  app.post('/api/workflows', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireWorkflowAdmin(actorContext, reply)) {
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

    await auditWorkflowMutation(prisma, actorContext, {
      action: 'workflow.template.created',
      metadata: { name: workflow.name },
      resourceId: workflow.id,
      resourceType: 'workflow_template',
    })

    return reply.code(201).send(createApiResponse(WorkflowTemplateRecordSchema.parse(workflow)))
  })

  app.get('/api/workflows/:workflowTemplateId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireWorkflowAdmin(actorContext, reply)) {
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

    await auditWorkflowMutation(prisma, actorContext, {
      action: 'workflow.template.updated',
      metadata: { name: workflow.name, version: workflow.version },
      resourceId: workflow.id,
      resourceType: 'workflow_template',
    })

    return createApiResponse(WorkflowTemplateRecordSchema.parse(workflow))
  })

  app.put('/api/workflows/:workflowTemplateId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireWorkflowAdmin(actorContext, reply)) {
      return reply
    }

    const body = parseInput(UpdateWorkflowTemplateBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { workflowTemplateId } = request.params as { workflowTemplateId: string }
    // The designer auto-saves, so it states the version it edited; a second
    // editor's save is refused instead of silently taking the graph over.
    const ifMatch = readIfMatchRevision(request)
    if (ifMatch.kind === 'malformed') return sendMalformedIfMatch(reply)

    let workflow
    try {
      workflow = await updateWorkflowTemplate(
        prisma,
        actorContext,
        workflowTemplateId,
        body,
        ifMatch.kind === 'revision' ? ifMatch.revision : undefined,
      )
    } catch (error) {
      if (error instanceof WorkflowTemplateVersionConflictError) {
        return sendRevisionConflict(
          reply,
          'WORKFLOW_TEMPLATE_VERSION_CONFLICT',
          'This workflow changed since you started editing',
          error.currentVersion,
        )
      }
      if (sendTemplateSaveError(reply, error)) {
        return reply
      }
      throw error
    }

    if (!workflow) {
      sendApiError(reply, 404, 'WORKFLOW_TEMPLATE_NOT_FOUND', 'Workflow template not found')
      return reply
    }

    await auditWorkflowMutation(prisma, actorContext, {
      action: 'workflow.template.updated',
      metadata: { name: workflow.name, version: workflow.version },
      resourceId: workflow.id,
      resourceType: 'workflow_template',
    })

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
    if (!requireWorkflowAdmin(actorContext, reply)) {
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
    if (!requireWorkflowAdmin(actorContext, reply)) {
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
