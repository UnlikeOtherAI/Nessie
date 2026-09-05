import type { PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  PolicyAction,
  PolicyDecision,
  PolicyResourceType,
} from '@nessie/schemas'
import {
  buildScopeChain,
  loadRulesForChecks,
  resolveDecision,
} from '@nessie/team-admin'

// Policy evaluation: the run/request hot path. `checkPolicy` itself moved to
// `@nessie/team-admin` so the worker can ask the same question before the
// assistant binds an agent to a channel; it is re-exported here so routes
// keep one import site. Rule CRUD lives in `policy-rules.ts`; default-policy
// seeding (a bootstrap/login-time concern with a very different lifetime)
// lives in `policy-seed.ts`.
export { checkPolicy } from '@nessie/team-admin'

export const checkPolicyBatch = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  checks: Array<{ resourceType: PolicyResourceType; action: PolicyAction }>,
): Promise<PolicyDecision[]> => {
  if (checks.length === 0) {
    return []
  }

  const orgId = actorContext.tenant.organizationId
  const chain = buildScopeChain(actorContext)
  const resourceTypes = Array.from(new Set(checks.map((c) => c.resourceType)))
  const actions = Array.from(new Set(checks.map((c) => c.action)))

  const grouped = await loadRulesForChecks(
    prisma,
    orgId,
    chain.scopeIds,
    resourceTypes,
    actions,
  )

  return checks.map((check) =>
    resolveDecision(grouped.get(`${check.resourceType}|${check.action}`) ?? [], chain),
  )
}

export const getEffectivePolicy = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  resourceTypes?: PolicyResourceType[],
  actions?: PolicyAction[],
) => {
  const allResourceTypes: PolicyResourceType[] = resourceTypes ?? [
    'agent', 'channel', 'project', 'tool', 'session', 'task',
    'review', 'approval', 'admin', 'secret', 'knowledge_space',
    'knowledge_page',
  ]
  const allActions: PolicyAction[] = actions ?? [
    'view', 'invoke', 'create', 'edit', 'assign', 'approve',
    'review', 'search', 'admin', 'bind',
  ]

  const orgId = actorContext.tenant.organizationId
  const chain = buildScopeChain(actorContext)

  const grouped = await loadRulesForChecks(
    prisma,
    orgId,
    chain.scopeIds,
    allResourceTypes,
    allActions,
  )

  const decisions: Array<{
    resourceType: PolicyResourceType
    action: PolicyAction
    decision: PolicyDecision
  }> = []

  for (const resourceType of allResourceTypes) {
    for (const action of allActions) {
      const decision = resolveDecision(
        grouped.get(`${resourceType}|${action}`) ?? [],
        chain,
      )
      decisions.push({ resourceType, action, decision })
    }
  }

  return { decisions }
}
