import type { FastifyInstance } from 'fastify'

import {
  AddPolicyBindingBodySchema,
  CreatePolicyRuleBodySchema,
  PolicyCheckBodySchema,
  UpdatePolicyRuleBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { checkPolicy, getEffectivePolicy } from '../services/policy.js'
import {
  addPolicyBinding,
  createPolicyRule,
  deletePolicyRule,
  listPolicyRules,
  removePolicyBinding,
  updatePolicyRule,
} from '../services/policy-rules.js'
import type { RouteDeps } from './types.js'

export const registerPolicyRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner } = deps

  app.get('/api/policy/effective', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const result = await getEffectivePolicy(prisma, actorContext)
    return createApiResponse(result)
  })

  app.post('/api/policy/check', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(PolicyCheckBodySchema, request.body, reply)
    if (!body) return reply

    const decision = await checkPolicy(prisma, actorContext, body.resourceType, body.action)

    return createApiResponse(decision)
  })

  app.get('/api/policy/rules', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as Record<string, string | undefined>
    type ListPolicyRulesFilters = Parameters<typeof listPolicyRules>[2]
    const result = await listPolicyRules(prisma, actorContext.tenant.organizationId, {
      scope: query['scope'] as ListPolicyRulesFilters extends { scope?: infer S } ? S : never,
      scopeId: query['scopeId'],
      resourceType:
        query['resourceType'] as ListPolicyRulesFilters extends { resourceType?: infer R }
          ? R
          : never,
      cursor: query['cursor'],
      direction: query['direction'] === 'backward' ? 'backward' : 'forward',
      limit: query['limit'] ? parseInt(query['limit'], 10) : undefined,
    })

    return { data: result.data, meta: result.meta }
  })

  app.post('/api/policy/rules', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(CreatePolicyRuleBodySchema, request.body, reply)
    if (!body) return reply

    const rule = await createPolicyRule(prisma, {
      organizationId: actorContext.tenant.organizationId,
      scope: body.scope,
      scopeId: body.scopeId,
      resourceType: body.resourceType,
      action: body.action,
      effect: body.effect,
      priority: body.priority,
      conditions: body.conditions,
      createdBy: actorContext.actor.actorId,
      bindings: body.bindings,
    })

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'policy.created',
      resourceType: 'policy',
      resourceId: rule.id,
      outcome: 'success',
    })

    return reply.code(201).send(createApiResponse(rule))
  })

  app.put('/api/policy/rules/:ruleId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { ruleId } = request.params as { ruleId: string }
    const body = parseInput(UpdatePolicyRuleBodySchema, request.body, reply)
    if (!body) return reply

    const rule = await updatePolicyRule(prisma, ruleId, actorContext.tenant.organizationId, {
      effect: body.effect,
      priority: body.priority,
      conditions: body.conditions,
    })

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'policy.updated',
      resourceType: 'policy',
      resourceId: ruleId,
      outcome: 'success',
    })

    return createApiResponse(rule)
  })

  app.delete('/api/policy/rules/:ruleId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { ruleId } = request.params as { ruleId: string }
    await deletePolicyRule(prisma, ruleId, actorContext.tenant.organizationId)

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'policy.deleted',
      resourceType: 'policy',
      resourceId: ruleId,
      outcome: 'success',
    })

    return reply.code(204).send()
  })

  app.post('/api/policy/rules/:ruleId/bindings', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { ruleId } = request.params as { ruleId: string }
    const body = parseInput(AddPolicyBindingBodySchema, request.body, reply)
    if (!body) return reply

    const binding = await addPolicyBinding(
      prisma,
      ruleId,
      actorContext.tenant.organizationId,
      body.actorType,
      body.actorId,
    )
    if (!binding) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Policy rule not found')
      return reply
    }

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'policy.updated',
      resourceType: 'policy',
      resourceId: ruleId,
      outcome: 'success',
      metadata: { op: 'binding.added', bindingId: binding.id, actorType: body.actorType, actorId: body.actorId },
    })

    return reply.code(201).send(createApiResponse(binding))
  })

  app.delete('/api/policy/rules/:ruleId/bindings/:bindingId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { ruleId, bindingId } = request.params as { ruleId: string; bindingId: string }
    const removed = await removePolicyBinding(prisma, bindingId, actorContext.tenant.organizationId)
    if (!removed) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Policy binding not found')
      return reply
    }

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'policy.updated',
      resourceType: 'policy',
      resourceId: ruleId,
      outcome: 'success',
      metadata: { op: 'binding.removed', bindingId },
    })

    return reply.code(204).send()
  })
}
