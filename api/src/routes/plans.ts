import type { FastifyInstance } from 'fastify'

import {
  CreatePlanBodySchema,
  CreatePlanStepBodySchema,
  PlanRecordSchema,
  PlanStepRecordSchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  addPlanStep,
  createPlan,
  getPlan,
  listPlans,
  PLAN_ERROR_CODES,
  PlanError,
} from '../services/plans.js'
import type { RouteDeps } from './types.js'

export const registerPlanRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner } = deps

  app.get('/api/plans', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const query = request.query as { agentId?: string; status?: string }
    const plans = await listPlans(prisma, actorContext.tenant.organizationId, {
      agentId: query.agentId,
      status:
        query.status &&
        ['draft', 'active', 'waiting', 'completed', 'failed', 'cancelled'].includes(query.status)
          ? (query.status as 'active' | 'cancelled' | 'completed' | 'draft' | 'failed' | 'waiting')
          : undefined,
    })
    return createApiResponse(PlanRecordSchema.array().parse(plans))
  })

  app.post('/api/plans', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreatePlanBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const plan = await createPlan(prisma, actorContext, body)
    return reply.code(201).send(createApiResponse(PlanRecordSchema.parse(plan)))
  })

  app.get('/api/plans/:planId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { planId } = request.params as { planId: string }
    const plan = await getPlan(prisma, actorContext.tenant.organizationId, planId)
    if (!plan) {
      sendApiError(reply, 404, 'PLAN_NOT_FOUND', 'Plan not found')
      return reply
    }

    return createApiResponse({
      plan: PlanRecordSchema.parse(plan.plan),
      steps: PlanStepRecordSchema.array().parse(plan.steps),
    })
  })

  app.post('/api/plans/:planId/steps', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreatePlanStepBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { planId } = request.params as { planId: string }
    let step
    try {
      step = await addPlanStep(prisma, actorContext.tenant.organizationId, planId, body)
    }
    catch (error) {
      if (error instanceof PlanError && error.code === PLAN_ERROR_CODES.STEP_SEQUENCE_CONFLICT) {
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
      throw error
    }
    if (!step) {
      sendApiError(reply, 404, 'PLAN_NOT_FOUND', 'Plan not found')
      return reply
    }

    return reply.code(201).send(createApiResponse(PlanStepRecordSchema.parse(step)))
  })
}
