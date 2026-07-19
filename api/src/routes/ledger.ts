import type { FastifyInstance } from 'fastify'

import {
  deleteBudget,
  listBudgetStatuses,
  recomputeTokenLedgerCosts,
  setBudgetConfig,
} from '@nessie/runtime'
import {
  LedgerBillingGroupBySchema,
  LedgerBillingMonthSchema,
} from '@nessie/schemas'
import {
  BudgetScopeIdSchema,
  BudgetScopeTypeSchema,
  BudgetStatusResponseSchema,
  SetBudgetBodySchema,
  SetPricingProfileBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  createPricingProfile,
  deletePricingProfile,
  getConnectorUsageSummary,
  getFileUsageSummary,
  getMonthlyEstimate,
  getTokenUsageSummary,
  listPricingProfiles,
} from '../services/token-ledger.js'
import {
  getLedgerBillingUsage,
  LedgerBillingUsageError,
} from '../services/ledger-billing-usage.js'
import type { RouteDeps } from './types.js'

const billingUsageStatus = (error: LedgerBillingUsageError): number => {
  switch (error.code) {
    case 'LEDGER_BILLING_SSO_REQUIRED':
      return 403
    case 'LEDGER_BILLING_CONTEXT_MISMATCH':
      return 409
    case 'LEDGER_BILLING_UNCONFIGURED':
      return 503
    case 'LEDGER_BILLING_RESPONSE_INVALID':
    case 'LEDGER_BILLING_UPSTREAM_REJECTED':
      return 502
  }
}

export const registerLedgerRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner } = deps

  app.get('/api/ledger/billing/usage', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (
      !actorContext.actor.roles?.some((role) =>
        role === 'owner' || role === 'admin'
      )
    ) {
      sendApiError(reply, 403, 'FORBIDDEN', 'Owner or admin access required')
      return reply
    }

    const query = request.query as Record<string, unknown>
    const month = LedgerBillingMonthSchema.safeParse(query['month'])
    const groupBy = LedgerBillingGroupBySchema.safeParse(
      query['groupBy'] ?? 'service',
    )
    if (!month.success || !groupBy.success) {
      sendApiError(
        reply,
        400,
        'VALIDATION_ERROR',
        'month (YYYY-MM) and groupBy (service, team, or user) are required',
        'query',
      )
      return reply
    }

    try {
      return createApiResponse(
        await getLedgerBillingUsage(prisma, actorContext, {
          groupBy: groupBy.data,
          month: month.data,
        }),
      )
    } catch (error) {
      if (error instanceof LedgerBillingUsageError) {
        sendApiError(
          reply,
          billingUsageStatus(error),
          error.code,
          error.message,
        )
        return reply
      }
      throw error
    }
  })

  app.get('/api/ledger/tokens/summary', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as Record<string, string | undefined>
    const summary = await getTokenUsageSummary(prisma, actorContext.tenant.organizationId, {
      projectId: query['projectId'],
      teamId: query['teamId'],
      channelId: query['channelId'],
      runId: query['runId'],
      agentId: query['agentId'],
      userId: query['userId'],
      actorId: query['actorId'],
      provider: query['provider'],
      model: query['model'],
      from: query['from'],
      to: query['to'],
      groupBy: query['groupBy'],
    })

    return createApiResponse(summary)
  })

  app.get('/api/ledger/connectors/summary', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as Record<string, string | undefined>
    const summary = await getConnectorUsageSummary(prisma, actorContext.tenant.organizationId, {
      connectorType: query['connectorType'],
      agentId: query['agentId'],
      userId: query['userId'],
      channelId: query['channelId'],
      connectorId: query['connectorId'],
      from: query['from'],
      to: query['to'],
      groupBy: query['groupBy'],
    })

    return createApiResponse(summary)
  })

  app.get('/api/ledger/files/summary', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as Record<string, string | undefined>
    const summary = await getFileUsageSummary(prisma, actorContext.tenant.organizationId, {
      from: query['from'],
      to: query['to'],
    })

    return createApiResponse(summary)
  })

  app.get('/api/ledger/tokens/monthly-estimate', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const estimate = await getMonthlyEstimate(prisma, actorContext.tenant.organizationId)
    return createApiResponse(estimate)
  })

  app.get('/api/ledger/tokens/pricing', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const profiles = await listPricingProfiles(prisma, actorContext.tenant.organizationId)
    return createApiResponse(profiles)
  })

  app.post('/api/ledger/tokens/pricing', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(SetPricingProfileBodySchema, request.body, reply)
    if (!body) return reply

    const profile = await createPricingProfile(
      prisma,
      actorContext.tenant.organizationId,
      {
        provider: body.provider,
        modelPattern: body.modelPattern,
        currency: body.currency ?? undefined,
        source: body.source ?? 'manual',
        inputPerMillion: body.inputPerMillion ?? undefined,
        outputPerMillion: body.outputPerMillion ?? undefined,
        cachedInputPerMillion: body.cachedInputPerMillion ?? undefined,
        cachedOutputPerMillion: body.cachedOutputPerMillion ?? undefined,
        cacheReadPerMillion: body.cacheReadPerMillion ?? undefined,
        cacheWritePerMillion: body.cacheWritePerMillion ?? undefined,
      },
      actorContext,
    )

    return reply.code(201).send(createApiResponse(profile))
  })

  app.delete('/api/ledger/tokens/pricing/:profileId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { profileId } = request.params as { profileId: string }
    await deletePricingProfile(prisma, profileId, actorContext.tenant.organizationId, actorContext)
    return reply.code(204).send()
  })

  // Value historical usage that was logged before pricing existed (those events
  // stay $0 because cost is computed at write time). Re-prices only still-null
  // events with the current pricing; already-priced rows are untouched.
  app.post('/api/ledger/tokens/recompute-costs', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const result = await recomputeTokenLedgerCosts(prisma, actorContext.tenant.organizationId)
    return createApiResponse(result)
  })

  // Verify a budget scopeId belongs to the actor's organization before it can be
  // configured, so an owner cannot write a budget for another tenant's project/team.
  const budgetScopeBelongsToOrg = async (
    organizationId: string,
    scopeType: 'organization' | 'project' | 'team',
    scopeId: string,
  ): Promise<boolean> => {
    if (scopeType === 'organization') return scopeId === organizationId
    if (scopeType === 'project') {
      const project = await prisma.project.findFirst({
        where: { id: scopeId, organizationId },
        select: { id: true },
      })
      return Boolean(project)
    }
    const team = await prisma.team.findFirst({
      where: { id: scopeId, project: { organizationId } },
      select: { id: true },
    })
    return Boolean(team)
  }

  app.get('/api/ledger/budgets', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const statuses = await listBudgetStatuses(prisma, actorContext.tenant.organizationId)
    return createApiResponse(BudgetStatusResponseSchema.array().parse(statuses))
  })

  app.put('/api/ledger/budget', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(SetBudgetBodySchema, request.body, reply)
    if (!body) return reply

    if (!(await budgetScopeBelongsToOrg(actorContext.tenant.organizationId, body.scopeType, body.scopeId))) {
      sendApiError(reply, 400, 'INVALID_SCOPE', 'Budget scope does not belong to this organization')
      return reply
    }

    const status = await setBudgetConfig(prisma, {
      organizationId: actorContext.tenant.organizationId,
      ...body,
    })
    return createApiResponse(BudgetStatusResponseSchema.parse(status))
  })

  app.delete('/api/ledger/budget', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as { scopeType?: string; scopeId?: string }
    const parsedScope = BudgetScopeTypeSchema.safeParse(query.scopeType)
    const parsedScopeId = BudgetScopeIdSchema.safeParse(query.scopeId)
    if (!parsedScope.success || !parsedScopeId.success) {
      sendApiError(reply, 400, 'INVALID_INPUT', 'scopeType and a valid scopeId (UUID) are required')
      return reply
    }

    const removed = await deleteBudget(
      prisma,
      actorContext.tenant.organizationId,
      parsedScope.data,
      parsedScopeId.data,
    )
    if (!removed) {
      sendApiError(reply, 404, 'NOT_FOUND', 'No budget configured for that scope')
      return reply
    }
    return reply.code(204).send()
  })
}
