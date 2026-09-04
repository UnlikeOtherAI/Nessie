import type { FastifyInstance } from 'fastify'

import { createApiResponse, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import {
  addPolicyBinding,
  checkPolicy,
  createPolicyRule,
  deletePolicyRule,
  getEffectivePolicy,
  listPolicyRules,
  removePolicyBinding,
  updatePolicyRule,
} from '../services/policy.js'
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

    const body = request.body as { resourceType?: string; action?: string } | undefined
    if (!body?.resourceType || !body?.action) {
      sendApiError(reply, 400, 'INVALID_INPUT', 'resourceType and action are required')
      return reply
    }

    const decision = await checkPolicy(
      prisma,
      actorContext,
      body.resourceType as Parameters<typeof checkPolicy>[2],
      body.action as Parameters<typeof checkPolicy>[3],
    )

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

    const body = request.body as {
      scope: string
      scopeId: string
      resourceType: string
      action: string
      effect: string
      priority?: number
      conditions?: Record<string, unknown>
      bindings?: Array<{ actorType: string; actorId: string }>
    }

    const rule = await createPolicyRule(prisma, {
      organizationId: actorContext.tenant.organizationId,
      scope: body.scope as Parameters<typeof createPolicyRule>[1]['scope'],
      scopeId: body.scopeId,
      resourceType: body.resourceType as Parameters<typeof createPolicyRule>[1]['resourceType'],
      action: body.action as Parameters<typeof createPolicyRule>[1]['action'],
      effect: body.effect as Parameters<typeof createPolicyRule>[1]['effect'],
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
    const body = request.body as {
      effect?: string
      priority?: number
      conditions?: Record<string, unknown> | null
    }

    const rule = await updatePolicyRule(prisma, ruleId, actorContext.tenant.organizationId, {
      effect: body.effect as Parameters<typeof updatePolicyRule>[3]['effect'],
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
    const body = request.body as { actorType: string; actorId: string }

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
