import { Prisma, type PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  PolicyAction,
  PolicyDecision,
  PolicyEffect,
  PolicyResourceType,
  PolicyScope,
} from '@nessie/schemas'

// Scope weight: org=0, project=1, team=2, channel=3, agent=4, tool=5, user=6
const SCOPE_WEIGHT: Record<string, number> = {
  organization: 0,
  project: 1,
  team: 2,
  channel: 3,
  agent: 4,
  tool: 5,
  user: 6,
}

type PolicyRuleRow = {
  action: string
  actorId: string
  actorType: string
  conditions: unknown
  effect: string
  id: string
  priority: number
  resourceType: string
  scope: string
  scopeId: string
}

const actionToPrisma = (action: string) => {
  if (action === 'export') return 'export_action'
  if (action === 'import') return 'import_action'
  return action
}

const evaluateConditions = (
  conditions: Record<string, unknown> | null,
): boolean => {
  if (!conditions) return true

  if (conditions['timeWindow']) {
    const tw = conditions['timeWindow'] as {
      startHour: number
      endHour: number
      daysOfWeek: number[]
    }
    const now = new Date()
    const hour = now.getUTCHours()
    const day = now.getUTCDay()
    if (!tw.daysOfWeek.includes(day)) return false
    if (tw.startHour <= tw.endHour) {
      if (hour < tw.startHour || hour >= tw.endHour) return false
    } else {
      if (hour < tw.startHour && hour >= tw.endHour) return false
    }
  }

  return true
}

type PolicyScopeChain = {
  actorId: string
  actorRoles: string[]
  agentId?: string
  scopeIds: string[]
}

const buildScopeChain = (
  actorContext: AuthorizedActionContext,
  additionalScopeIds?: { agentId?: string; channelId?: string; toolId?: string },
): PolicyScopeChain => {
  const orgId = actorContext.tenant.organizationId
  const projectId = actorContext.tenant.projectId
  const teamId = actorContext.tenant.teamId
  const channelId = additionalScopeIds?.channelId ?? actorContext.actionContext.channelId
  const agentId = additionalScopeIds?.agentId ?? actorContext.actionContext.agentId
  const toolId = additionalScopeIds?.toolId ?? actorContext.actionContext.toolId
  const actorId = actorContext.actor.actorId
  const actorRoles = actorContext.actor.roles ?? []

  const scopeIds: string[] = [orgId]
  if (projectId) scopeIds.push(projectId)
  if (teamId) scopeIds.push(teamId)
  if (channelId) scopeIds.push(channelId)
  if (agentId) scopeIds.push(agentId)
  if (toolId) scopeIds.push(toolId)
  scopeIds.push(actorId)

  return { actorId, actorRoles, agentId, scopeIds }
}

// Evaluate pre-fetched rules (already filtered to the org + scope chain) for one
// resourceType/action pair using the deny-overrides resolution.
const resolveDecision = (
  rules: PolicyRuleRow[],
  chain: PolicyScopeChain,
): PolicyDecision => {
  const { actorId, actorRoles, agentId } = chain

  // Filter by actor match
  const matchingRules = rules.filter((rule) => {
    if (rule.actorId === '*') return true
    if (rule.actorType === 'user' && rule.actorId === actorId) return true
    if (rule.actorType === 'role' && actorRoles.includes(rule.actorId)) return true
    if (rule.actorType === 'agent' && rule.actorId === agentId) return true
    return false
  })

  // Sort by scope weight then priority
  matchingRules.sort((a, b) => {
    const wa = SCOPE_WEIGHT[a.scope] ?? 99
    const wb = SCOPE_WEIGHT[b.scope] ?? 99
    if (wa !== wb) return wa - wb
    return a.priority - b.priority
  })

  // Deny-first evaluation
  let lastAllow: PolicyRuleRow | null = null

  for (const rule of matchingRules) {
    const conditionsPass = evaluateConditions(
      rule.conditions as Record<string, unknown> | null,
    )

    if (!conditionsPass) continue

    if (rule.effect === 'deny') {
      return {
        allowed: false,
        policyRuleId: rule.id,
        policySource: `${rule.scope}:${rule.scopeId}/deny`,
        reasonCode: 'EXPLICIT_DENY',
      }
    }

    if (rule.effect === 'allow') {
      // Check if approval is required
      const conditions = rule.conditions as Record<string, unknown> | null
      if (conditions?.['requiresApproval']) {
        return {
          allowed: false,
          policyRuleId: rule.id,
          policySource: `${rule.scope}:${rule.scopeId}/allow`,
          reasonCode: 'APPROVAL_REQUIRED',
          requiresApproval: true,
          approvalActionType: (conditions['approvalActionType'] as string) ?? undefined,
        }
      }
      lastAllow = rule
    }
  }

  if (lastAllow) {
    return {
      allowed: true,
      policyRuleId: lastAllow.id,
      policySource: `${lastAllow.scope}:${lastAllow.scopeId}/allow`,
      reasonCode: 'ALLOWED',
    }
  }

  return {
    allowed: false,
    policySource: 'none',
    reasonCode: 'NO_MATCHING_ALLOW',
  }
}

export const checkPolicy = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  resourceType: PolicyResourceType,
  action: PolicyAction,
  additionalScopeIds?: { agentId?: string; channelId?: string; toolId?: string },
): Promise<PolicyDecision> => {
  const orgId = actorContext.tenant.organizationId
  const chain = buildScopeChain(actorContext, additionalScopeIds)

  // Fetch all matching rules
  const rules = await prisma.$queryRaw<PolicyRuleRow[]>(Prisma.sql`
    SELECT pr.id, pr.scope, pr.scope_id as "scopeId", pr.resource_type as "resourceType",
           pr.action, pr.effect, pr.priority, pr.conditions,
           pb.actor_type as "actorType", pb.actor_id as "actorId"
    FROM policy_rules pr
    JOIN policy_bindings pb ON pb.policy_rule_id = pr.id
    WHERE pr.organization_id = ${orgId}::uuid
      AND pr.resource_type = ${resourceType}::"PolicyResourceType"
      AND pr.action = ${action}::"PolicyAction"
      AND pr.scope_id IN (${Prisma.join(chain.scopeIds)})
    ORDER BY pr.priority ASC
  `)

  return resolveDecision(rules, chain)
}

// Load every rule for the org that matches the scope chain and the requested
// resourceType/action set in a single query, grouped by (resourceType, action).
const loadRulesForChecks = async (
  prisma: PrismaClient,
  orgId: string,
  scopeIds: string[],
  resourceTypes: PolicyResourceType[],
  actions: PolicyAction[],
): Promise<Map<string, PolicyRuleRow[]>> => {
  const rows = await prisma.$queryRaw<PolicyRuleRow[]>(Prisma.sql`
    SELECT pr.id, pr.scope, pr.scope_id as "scopeId", pr.resource_type as "resourceType",
           pr.action, pr.effect, pr.priority, pr.conditions,
           pb.actor_type as "actorType", pb.actor_id as "actorId"
    FROM policy_rules pr
    JOIN policy_bindings pb ON pb.policy_rule_id = pr.id
    WHERE pr.organization_id = ${orgId}::uuid
      AND pr.resource_type::text IN (${Prisma.join(resourceTypes)})
      AND pr.action::text IN (${Prisma.join(actions)})
      AND pr.scope_id IN (${Prisma.join(scopeIds)})
    ORDER BY pr.priority ASC
  `)

  const grouped = new Map<string, PolicyRuleRow[]>()
  for (const row of rows) {
    const key = `${row.resourceType}|${row.action}`
    const bucket = grouped.get(key)
    if (bucket) {
      bucket.push(row)
    } else {
      grouped.set(key, [row])
    }
  }
  return grouped
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

const parseCursor = (raw: string): { cursorDate: Date; cursorId: string } | null => {
  const [isoPart, idPart] = raw.split('|')
  if (!isoPart || !idPart) return null
  const d = new Date(isoPart)
  if (Number.isNaN(d.getTime())) return null
  return { cursorDate: d, cursorId: idPart }
}

export const listPolicyRules = async (
  prisma: PrismaClient,
  organizationId: string,
  filters?: {
    scope?: PolicyScope
    scopeId?: string
    resourceType?: PolicyResourceType
    cursor?: string
    limit?: number
  },
) => {
  const limit = Math.min(filters?.limit ?? 50, 200)
  const where: Record<string, unknown> = { organizationId }
  if (filters?.scope) where['scope'] = filters.scope
  if (filters?.scopeId) where['scopeId'] = filters.scopeId
  if (filters?.resourceType) where['resourceType'] = filters.resourceType
  if (filters?.cursor) {
    const parsed = parseCursor(filters.cursor)
    if (parsed) {
      where['OR'] = [
        { createdAt: { gt: parsed.cursorDate } },
        { createdAt: parsed.cursorDate, id: { gt: parsed.cursorId } },
      ]
    }
  }

  const rules = await prisma.policyRule.findMany({
    where: where as Prisma.PolicyRuleWhereInput,
    include: { bindings: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
  })

  const hasMore = rules.length > limit
  const data = hasMore ? rules.slice(0, limit) : rules
  const last = data.at(-1)

  return {
    data: data.map(mapPolicyRule),
    meta: {
      cursor: hasMore && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
      hasMore,
    },
  }
}

export const createPolicyRule = async (
  prisma: PrismaClient,
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
  prisma: PrismaClient,
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
  prisma: PrismaClient,
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
  prisma: PrismaClient,
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
