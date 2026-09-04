import { Prisma, type PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  PolicyAction,
  PolicyDecision,
  PolicyEffect,
  PolicyResourceType,
  PolicyScope,
} from '@nessie/schemas'
import { buildPage, decodeKeysetCursor, resolvePageLimit, type PaginationDirection } from '@nessie/schemas'
import {
  buildScopeChain,
  loadRulesForChecks,
  resolveDecision,
} from '@nessie/team-admin'

// Policy evaluation moved to `@nessie/team-admin` so the worker can ask
// the same question before the assistant binds an agent to a channel. Rule
// authoring and default seeding stay here; `checkPolicy` is re-exported so
// routes keep one import site.
export { checkPolicy } from '@nessie/team-admin'

const actionToPrisma = (action: string) => {
  if (action === 'export') return 'export_action'
  if (action === 'import') return 'import_action'
  return action
}

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

// ─── CRUD ────────────────────────────────────────────────────────────────────

export const listPolicyRules = async (
  prisma: PrismaClient,
  organizationId: string,
  filters?: {
    scope?: PolicyScope
    scopeId?: string
    resourceType?: PolicyResourceType
    cursor?: string
    direction?: PaginationDirection
    limit?: number
  },
) => {
  const limit = resolvePageLimit(filters?.limit)
  const where: Record<string, unknown> = { organizationId }
  if (filters?.scope) where['scope'] = filters.scope
  if (filters?.scopeId) where['scopeId'] = filters.scopeId
  if (filters?.resourceType) where['resourceType'] = filters.resourceType

  // The total is counted against the same filters but before the cursor is
  // applied: "26–50 of 134" has to mean 134 matching records, not 134 records
  // after the one this page starts at.
  const total = await prisma.policyRule.count({ where: where as Prisma.PolicyRuleWhereInput })

  const parsed = decodeKeysetCursor(filters?.cursor)
  const backwards = filters?.direction === 'backward'
  if (parsed) {
    where['OR'] = [
      { createdAt: { [backwards ? 'lt' : 'gt']: parsed.createdAt } },
      { createdAt: parsed.createdAt, id: { [backwards ? 'lt' : 'gt']: parsed.id } },
    ]
  }

  const rules = await prisma.policyRule.findMany({
    where: where as Prisma.PolicyRuleWhereInput,
    include: { bindings: true },
    orderBy: backwards
      ? [{ createdAt: 'desc' }, { id: 'desc' }]
      : [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
  })

  const page = buildPage({
    direction: filters?.direction,
    hasCursor: Boolean(parsed),
    limit,
    rows: rules,
    total,
  })

  return {
    data: page.data.map(mapPolicyRule),
    meta: page.meta,
  }
}

export const createPolicyRule = async (
  prisma: Pick<PrismaClient, 'policyRule'>,
  input: {
    organizationId: string
    scope: PolicyScope
    scopeId: string
    resourceType: PolicyResourceType
    action: PolicyAction
    effect: PolicyEffect
    priority?: number
    conditions?: Record<string, unknown>
    createdBy: string
    bindings?: Array<{ actorType: string; actorId: string }>
  },
) => {
  const rule = await prisma.policyRule.create({
    data: {
      organizationId: input.organizationId,
      scope: input.scope,
      scopeId: input.scopeId,
      resourceType: input.resourceType,
      action: actionToPrisma(input.action) as Exclude<typeof input.action, 'export' | 'import'>,
      effect: input.effect,
      priority: input.priority ?? 0,
      conditions: (input.conditions as Prisma.InputJsonValue) ?? undefined,
      createdBy: input.createdBy,
      bindings: input.bindings
        ? {
            create: input.bindings.map((b) => ({
              actorType: b.actorType,
              actorId: b.actorId,
            })),
          }
        : undefined,
    },
    include: { bindings: true },
  })

  return mapPolicyRule(rule)
}

export const updatePolicyRule = async (
  prisma: PrismaClient,
  ruleId: string,
  organizationId: string,
  input: {
    effect?: PolicyEffect
    priority?: number
    conditions?: Record<string, unknown> | null
  },
) => {
  const rule = await prisma.policyRule.update({
    where: { id: ruleId, organizationId },
    data: {
      effect: input.effect,
      priority: input.priority,
      conditions: input.conditions === null ? undefined : (input.conditions as Prisma.InputJsonValue),
    },
    include: { bindings: true },
  })

  return mapPolicyRule(rule as typeof rule & { bindings: Array<{ id: string; actorType: string; actorId: string }> })
}

export const deletePolicyRule = async (
  prisma: PrismaClient,
  ruleId: string,
  organizationId: string,
) => {
  await prisma.policyRule.delete({
    where: { id: ruleId, organizationId },
  })
}

export const addPolicyBinding = async (
  prisma: PrismaClient,
  ruleId: string,
  organizationId: string,
  actorType: string,
  actorId: string,
) => {
  // Scope the parent rule to the caller's organization. Without this, an owner of
  // one org could attach a binding to another org's policy rule (cross-tenant
  // write IDOR) by passing a foreign ruleId.
  const rule = await prisma.policyRule.findFirst({
    where: { id: ruleId, organizationId },
    select: { id: true },
  })
  if (!rule) return null

  const binding = await prisma.policyBinding.create({
    data: { policyRuleId: ruleId, actorType, actorId },
  })
  return { id: binding.id, actorType: binding.actorType, actorId: binding.actorId }
}

export const removePolicyBinding = async (
  prisma: PrismaClient,
  bindingId: string,
  organizationId: string,
): Promise<boolean> => {
  // Only delete a binding whose parent rule belongs to the caller's org, so a
  // foreign bindingId cannot be used to mutate another tenant's policy.
  const { count } = await prisma.policyBinding.deleteMany({
    where: { id: bindingId, policyRule: { is: { organizationId } } },
  })
  return count > 0
}

// ─── Default seed policies ──────────────────────────────────────────────────

const ensureAgentBindDefaultPolicies = async (
  prisma: Pick<PrismaClient, 'policyRule'>,
  organizationId: string,
  createdBy: string,
): Promise<void> => {
  const ensureRule = async (input: {
    actorId: string
    effect: PolicyEffect
    priority: number
  }) => {
    const existingRule = await prisma.policyRule.findFirst({
      where: {
        action: actionToPrisma('bind') as 'bind',
        bindings: {
          some: {
            actorId: input.actorId,
            actorType: 'role',
          },
        },
        effect: input.effect,
        organizationId,
        resourceType: 'agent',
        scope: 'organization',
        scopeId: organizationId,
      },
      select: { id: true },
    })

    if (existingRule) {
      return
    }

    await createPolicyRule(prisma, {
      organizationId,
      scope: 'organization',
      scopeId: organizationId,
      resourceType: 'agent',
      action: 'bind',
      effect: input.effect,
      priority: input.priority,
      createdBy,
      bindings: [{ actorType: 'role', actorId: input.actorId }],
    })
  }

  await ensureRule({ actorId: 'member', effect: 'deny', priority: 50 })
  await ensureRule({ actorId: 'owner', effect: 'allow', priority: 10 })
}

// The original default rule set had no knowledge_space / knowledge_page rules,
// which left every knowledge action denied (deny-by-default). Grant org members
// the authoring actions so the knowledge base is usable; reserve approve for
// owners. Fine-grained per-space privacy is enforced separately in the knowledge
// provider, not here. Idempotent so it also backfills existing organizations on
// startup.
const ensureKnowledgeDefaultPolicies = async (
  prisma: Pick<PrismaClient, 'policyRule'>,
  organizationId: string,
  createdBy: string,
): Promise<void> => {
  const ensure = async (
    resourceType: PolicyResourceType,
    action: PolicyAction,
    actorId: string,
    priority: number,
  ) => {
    const existingRule = await prisma.policyRule.findFirst({
      where: {
        action: actionToPrisma(action) as Exclude<PolicyAction, 'export' | 'import'>,
        bindings: { some: { actorId, actorType: 'role' } },
        effect: 'allow',
        organizationId,
        resourceType,
        scope: 'organization',
        scopeId: organizationId,
      },
      select: { id: true },
    })
    if (existingRule) return
    await createPolicyRule(prisma, {
      organizationId,
      scope: 'organization',
      scopeId: organizationId,
      resourceType,
      action,
      effect: 'allow',
      priority,
      createdBy,
      bindings: [{ actorType: 'role', actorId }],
    })
  }

  for (const action of ['view', 'create', 'edit'] as const) {
    await ensure('knowledge_space', action, '*', 100)
  }
  for (const action of ['view', 'create', 'edit', 'read', 'search'] as const) {
    await ensure('knowledge_page', action, '*', 100)
  }
  await ensure('knowledge_page', 'approve', 'owner', 10)
}

export const seedDefaultPolicies = async (
  prisma: Pick<PrismaClient, 'policyRule'>,
  organizationId: string,
  createdBy: string,
) => {
  const existing = await prisma.policyRule.count({ where: { organizationId } })
  await ensureKnowledgeDefaultPolicies(prisma, organizationId, createdBy)
  if (existing > 0) {
    await ensureAgentBindDefaultPolicies(prisma, organizationId, createdBy)
    return
  }

  // Allow org members to view public channels
  await createPolicyRule(prisma, {
    organizationId,
    scope: 'organization',
    scopeId: organizationId,
    resourceType: 'channel',
    action: 'view',
    effect: 'allow',
    priority: 100,
    createdBy,
    bindings: [{ actorType: 'role', actorId: '*' }],
  })

  // Deny non-admins from admin actions
  await createPolicyRule(prisma, {
    organizationId,
    scope: 'organization',
    scopeId: organizationId,
    resourceType: 'admin',
    action: 'admin',
    effect: 'deny',
    priority: 50,
    createdBy,
    bindings: [{ actorType: 'role', actorId: 'member' }],
  })

  // Allow admins all admin actions
  await createPolicyRule(prisma, {
    organizationId,
    scope: 'organization',
    scopeId: organizationId,
    resourceType: 'admin',
    action: 'admin',
    effect: 'allow',
    priority: 10,
    createdBy,
    bindings: [{ actorType: 'role', actorId: 'owner' }],
  })

  // Allow project members to view/invoke agents
  await createPolicyRule(prisma, {
    organizationId,
    scope: 'organization',
    scopeId: organizationId,
    resourceType: 'agent',
    action: 'view',
    effect: 'allow',
    priority: 100,
    createdBy,
    bindings: [{ actorType: 'role', actorId: '*' }],
  })

  await createPolicyRule(prisma, {
    organizationId,
    scope: 'organization',
    scopeId: organizationId,
    resourceType: 'agent',
    action: 'invoke',
    effect: 'allow',
    priority: 100,
    createdBy,
    bindings: [{ actorType: 'role', actorId: '*' }],
  })

  // Deny regular members from binding agents to channels
  await createPolicyRule(prisma, {
    organizationId,
    scope: 'organization',
    scopeId: organizationId,
    resourceType: 'agent',
    action: 'bind',
    effect: 'deny',
    priority: 50,
    createdBy,
    bindings: [{ actorType: 'role', actorId: 'member' }],
  })

  // Allow owners to bind agents to channels
  await createPolicyRule(prisma, {
    organizationId,
    scope: 'organization',
    scopeId: organizationId,
    resourceType: 'agent',
    action: 'bind',
    effect: 'allow',
    priority: 10,
    createdBy,
    bindings: [{ actorType: 'role', actorId: 'owner' }],
  })

  // Allow viewing tools
  await createPolicyRule(prisma, {
    organizationId,
    scope: 'organization',
    scopeId: organizationId,
    resourceType: 'tool',
    action: 'view',
    effect: 'allow',
    priority: 100,
    createdBy,
    bindings: [{ actorType: 'role', actorId: '*' }],
  })
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const mapPolicyRule = (rule: {
  id: string
  organizationId: string
  scope: string
  scopeId: string
  resourceType: string
  action: string
  effect: string
  priority: number
  conditions: unknown
  createdBy: string
  createdAt: Date
  updatedAt: Date
  bindings: Array<{ id: string; actorType: string; actorId: string }>
}) => ({
  id: rule.id,
  organizationId: rule.organizationId,
  scope: rule.scope,
  scopeId: rule.scopeId,
  resourceType: rule.resourceType,
  action: rule.action,
  effect: rule.effect,
  priority: rule.priority,
  conditions: rule.conditions as Record<string, unknown> | null,
  createdBy: rule.createdBy,
  createdAt: rule.createdAt.toISOString(),
  updatedAt: rule.updatedAt.toISOString(),
  bindings: rule.bindings.map((b) => ({
    id: b.id,
    actorType: b.actorType,
    actorId: b.actorId,
  })),
})
