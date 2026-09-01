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
import { createWorkflowRun, listWorkflowRuns } from '../../services/workflow-runs.js'
import {
  installWorkflowTemplate,
  listWorkflowInstallations,
  updateWorkflowInstallation,
  WorkflowTemplateAdoptionRequiredError,
  WorkflowInstallationLifecycleError,
} from '../../services/workflow-templates.js'
import {
  WorkflowActionError,
  WorkflowSecretWriteError,
} from '../../services/workflow-validation.js'
import { auditWorkflowMutation } from '../../services/workflow-audit.js'
import {
  canActorReadWorkflowInstallation,
  canActorStartWorkflowRun,
  isWorkflowAdmin,
  workflowInstallationEntitlementFilter,
} from '../../services/workflow-entitlement.js'
import type { RouteDeps } from '../types.js'

/** W19: pause/resume/uninstall and install are org admin-or-owner actions. */
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

const installationIdFrom = (request: { params: unknown }): string =>
  (request.params as { installationId: string }).installationId

export const registerWorkflowInstallationRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, isWorkflowInstallationAccessibleToActor } = deps

  app.post('/api/workflows/:workflowTemplateId/install', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireWorkflowAdmin(actorContext, reply)) {
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
      if (error instanceof WorkflowActionError) {
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
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
      if (error instanceof WorkflowTemplateAdoptionRequiredError) {
        sendApiError(
          reply,
          409,
          'WORKFLOW_TEMPLATE_ADOPTION_REQUIRED',
          'This agent-proposed learned workflow needs owner adoption before installation.',
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

    await auditWorkflowMutation(prisma, actorContext, {
      action: 'workflow.installation.installed',
      metadata: { workflowTemplateId },
      resourceId: installation.id,
      resourceType: 'workflow_installation',
      status: installation.status,
    })

    return reply
      .code(201)
      .send(createApiResponse(WorkflowInstallationRecordSchema.parse(installation)))
  })

  app.get('/api/workflow-installations', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const query = parseInput(WorkflowListQuerySchema, request.query ?? {}, reply)
    if (!query) {
      return reply
    }

    // W19: members read the installations their entitlement covers — never
    // narrowed by the session claim, only by the explicit channelId filter.
    const entitlementWhere =
      (await workflowInstallationEntitlementFilter(prisma, actorContext)) ?? undefined
    const page = await listWorkflowInstallations(
      prisma,
      actorContext.tenant.organizationId,
      {
        ...query,
        ...(entitlementWhere ? { entitlementWhere } : {}),
      },
    )
    return createApiResponse(WorkflowInstallationRecordSchema.array().parse(page.data), page.meta)
  })

  // W8: pause / resume / disable / re-target. Status was write-once at
  // install; this is the update endpoint that makes `paused` reachable.
  app.patch('/api/workflow-installations/:installationId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireWorkflowAdmin(actorContext, reply)) {
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
      if (error instanceof WorkflowActionError) {
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
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

    await auditWorkflowMutation(prisma, actorContext, {
      action: 'workflow.installation.updated',
      metadata: {
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(body.status ? { requestedStatus: body.status } : {}),
      },
      resourceId: installation.id,
      resourceType: 'workflow_installation',
      status: installation.status,
    })

    return createApiResponse(WorkflowInstallationRecordSchema.parse(installation))
  })

  app.post('/api/workflow-installations/:installationId/run', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    // W19: manual start is member-level — the same channel entitlement that
    // lets a member trigger an agent there. 404 (not 403) when the actor has
    // no entitlement at all, so existence does not leak.
    if (!(await canActorStartWorkflowRun(prisma, actorContext, installationIdFrom(request)))) {
      sendApiError(reply, 404, 'WORKFLOW_INSTALLATION_NOT_FOUND', 'Workflow installation not found')
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
      // W26: an overlap-policy skip is a conflict, not a not-found.
      if (error instanceof WorkflowActionError) {
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
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
          WORKFLOW_RUN_ORIGIN_CHANNEL_NOT_FOUND: {
            code: 'WORKFLOW_RUN_ORIGIN_CHANNEL_NOT_FOUND',
            message: 'Origin channel not found',
          },
          WORKFLOW_RUN_ORIGIN_THREAD_NOT_FOUND: {
            code: 'WORKFLOW_RUN_ORIGIN_THREAD_NOT_FOUND',
            message: 'Origin thread not found',
          },
          WORKFLOW_RUN_ORIGIN_THREAD_MISMATCH: {
            code: 'WORKFLOW_RUN_ORIGIN_THREAD_MISMATCH',
            message: 'Origin thread does not belong to the origin channel',
          },
          WORKFLOW_RUN_ORIGIN_MESSAGE_NOT_FOUND: {
            code: 'WORKFLOW_RUN_ORIGIN_MESSAGE_NOT_FOUND',
            message: 'Origin message not found',
          },
          WORKFLOW_RUN_ORIGIN_MESSAGE_MISMATCH: {
            code: 'WORKFLOW_RUN_ORIGIN_MESSAGE_MISMATCH',
            message: 'Origin message does not belong to the origin thread',
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

    await auditWorkflowMutation(prisma, actorContext, {
      action: 'workflow.run.started',
      metadata: { installationId },
      resourceId: workflowRun.id,
      resourceType: 'workflow_run',
      status: workflowRun.status,
    })

    return reply.code(202).send(createApiResponse(WorkflowRunRecordSchema.parse(workflowRun)))
  })

  app.get('/api/workflow-installations/:installationId/runs', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!(await canActorReadWorkflowInstallation(prisma, actorContext, installationIdFrom(request)))) {
      sendApiError(reply, 404, 'WORKFLOW_INSTALLATION_NOT_FOUND', 'Workflow installation not found')
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
    return createApiResponse(WorkflowRunRecordSchema.array().parse(page.data), page.meta)
  })

  app.get('/api/workflow-installations/:installationId/triggers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { installationId } = request.params as { installationId: string }
    if (!(await canActorReadWorkflowInstallation(prisma, actorContext, installationId))) {
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
    if (!requireWorkflowAdmin(actorContext, reply)) {
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
