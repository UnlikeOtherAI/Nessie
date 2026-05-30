import type { FastifyInstance } from 'fastify'

import {
  CreateExecutionEnvironmentTemplateBodySchema,
  ExecutionEnvironmentInstanceRecordSchema,
  ExecutionEnvironmentTemplateRecordSchema,
  ExecutionLeaseRecordSchema,
  ExecutionRunnerRecordSchema,
  ExecutionUsageLedgerRecordSchema,
  LaunchExecutionEnvironmentBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { requestExecutionEnvironmentTermination } from '../services/execution-control-plane.js'
import {
  createExecutionEnvironmentTemplate,
  listExecutionEnvironmentInstances,
  listExecutionEnvironmentTemplates,
  listExecutionLeases,
  listExecutionRunners,
  listExecutionUsageLedger,
  requestExecutionEnvironmentLaunch,
} from '../services/execution-environments.js'
import type { RouteDeps } from './types.js'

export const registerExecutionEnvironmentRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner } = deps

  app.get('/api/execution-environment-templates', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const templates = await listExecutionEnvironmentTemplates(
      prisma,
      actorContext.tenant.organizationId,
    )
    return createApiResponse(
      ExecutionEnvironmentTemplateRecordSchema.array().parse(templates),
    )
  })

  app.post('/api/execution-environment-templates', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreateExecutionEnvironmentTemplateBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    let template
    try {
      template = await createExecutionEnvironmentTemplate(prisma, actorContext, body)
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'EXECUTION_ENVIRONMENT_CHANNEL_NOT_FOUND'
      ) {
        sendApiError(
          reply,
          404,
          'EXECUTION_ENVIRONMENT_CHANNEL_NOT_FOUND',
          'Execution environment channel not found',
        )
        return reply
      }
      throw error
    }

    return reply
      .code(201)
      .send(createApiResponse(ExecutionEnvironmentTemplateRecordSchema.parse(template)))
  })

  app.get('/api/execution-environment-instances', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const query = request.query as { workflowRunId?: string }
    const instances = await listExecutionEnvironmentInstances(
      prisma,
      actorContext.tenant.organizationId,
      {
        workflowRunId: query.workflowRunId,
      },
    )
    return createApiResponse(
      ExecutionEnvironmentInstanceRecordSchema.array().parse(instances),
    )
  })

  app.post('/api/execution-environment-instances', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(LaunchExecutionEnvironmentBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    let instance
    try {
      instance = await requestExecutionEnvironmentLaunch(prisma, actorContext, body)
    } catch (error) {
      if (error instanceof Error) {
        const executionErrorMap: Record<string, { code: string; message: string }> = {
          EXECUTION_ENVIRONMENT_AGENT_NOT_FOUND: {
            code: 'EXECUTION_ENVIRONMENT_AGENT_NOT_FOUND',
            message: 'Execution environment agent not found',
          },
          EXECUTION_ENVIRONMENT_CHANNEL_NOT_FOUND: {
            code: 'EXECUTION_ENVIRONMENT_CHANNEL_NOT_FOUND',
            message: 'Execution environment channel not found',
          },
          EXECUTION_ENVIRONMENT_RUN_NOT_FOUND: {
            code: 'EXECUTION_ENVIRONMENT_RUN_NOT_FOUND',
            message: 'Execution environment run not found',
          },
          EXECUTION_ENVIRONMENT_WORKFLOW_RUN_NOT_FOUND: {
            code: 'EXECUTION_ENVIRONMENT_WORKFLOW_RUN_NOT_FOUND',
            message: 'Execution environment workflow run not found',
          },
          EXECUTION_ENVIRONMENT_WORKFLOW_STEP_RUN_MISMATCH: {
            code: 'EXECUTION_ENVIRONMENT_WORKFLOW_STEP_RUN_MISMATCH',
            message: 'Execution environment workflow step run does not belong to the workflow run',
          },
          EXECUTION_ENVIRONMENT_WORKFLOW_STEP_RUN_NOT_FOUND: {
            code: 'EXECUTION_ENVIRONMENT_WORKFLOW_STEP_RUN_NOT_FOUND',
            message: 'Execution environment workflow step run not found',
          },
        }
        const mapped = executionErrorMap[error.message]
        if (mapped) {
          sendApiError(reply, 404, mapped.code, mapped.message)
          return reply
        }
      }
      throw error
    }

    if (!instance) {
      sendApiError(
        reply,
        404,
        'EXECUTION_ENVIRONMENT_TEMPLATE_NOT_FOUND',
        'Execution environment template not found or disabled',
      )
      return reply
    }

    return reply
      .code(202)
      .send(createApiResponse(ExecutionEnvironmentInstanceRecordSchema.parse(instance)))
  })

  app.post('/api/execution-environment-instances/:instanceId/terminate', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { instanceId } = request.params as { instanceId: string }
    const instance = await requestExecutionEnvironmentTermination(prisma, actorContext, {
      instanceId,
    })
    if (!instance) {
      sendApiError(
        reply,
        404,
        'EXECUTION_ENVIRONMENT_INSTANCE_NOT_FOUND',
        'Execution environment instance not found',
      )
      return reply
    }

    return reply
      .code(202)
      .send(createApiResponse(ExecutionEnvironmentInstanceRecordSchema.parse(instance)))
  })

  app.get('/api/execution-usage-ledger', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const query = request.query as { instanceId?: string; workflowRunId?: string }
    const usage = await listExecutionUsageLedger(prisma, actorContext.tenant.organizationId, {
      instanceId: query.instanceId,
      workflowRunId: query.workflowRunId,
    })
    return createApiResponse(ExecutionUsageLedgerRecordSchema.array().parse(usage))
  })

  app.get('/api/execution-runners', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const runners = await listExecutionRunners(prisma, actorContext.tenant.organizationId)
    return createApiResponse(ExecutionRunnerRecordSchema.array().parse(runners))
  })

  app.get('/api/execution-leases', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const query = request.query as { instanceId?: string }
    const leases = await listExecutionLeases(prisma, actorContext.tenant.organizationId, {
      instanceId: query.instanceId,
    })
    return createApiResponse(ExecutionLeaseRecordSchema.array().parse(leases))
  })
}
