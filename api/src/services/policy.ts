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

export const checkPolicy = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  resourceType: PolicyResourceType,
  action: PolicyAction,
  additionalScopeIds?: { agentId?: string; channelId?: string; toolId?: string },
): Promise<PolicyDecision> => {
  const orgId = actorContext.tenant.organizationId
  const projectId = actorContext.tenant.projectId
  const teamId = actorContext.tenant.teamId
  const channelId = additionalScopeIds?.channelId ?? actorContext.actionContext.channelId
  const agentId = additionalScopeIds?.agentId ?? actorContext.actionContext.agentId
  const toolId = additionalScopeIds?.toolId ?? actorContext.actionContext.toolId
  const actorId = actorContext.actor.actorId
  const actorRoles = actorContext.actor.roles ?? []

  // Build scope chain
  const scopeIds: Array<{ scope: string; scopeId: string }> = [
    { scope: 'organization', scopeId: orgId },
  ]
  if (projectId) scopeIds.push({ scope: 'project', scopeId: projectId })
  if (teamId) scopeIds.push({ scope: 'team', scopeId: teamId })
  if (channelId) scopeIds.push({ scope: 'channel', scopeId: channelId })
  if (agentId) scopeIds.push({ scope: 'agent', scopeId: agentId })
  if (toolId) scopeIds.push({ scope: 'tool', scopeId: toolId })
  scopeIds.push({ scope: 'user', scopeId: actorId })

  // Fetch all matching rules
  const scopeIdList = scopeIds.map((scopeEntry) => scopeEntry.scopeId)
  const rules = await prisma.$queryRaw<PolicyRuleRow[]>(Prisma.sql`
    SELECT pr.id, pr.scope, pr.scope_id as "scopeId", pr.resource_type as "resourceType",
           pr.action, pr.effect, pr.priority, pr.conditions,
           pb.actor_type as "actorType", pb.actor_id as "actorId"
    FROM policy_rules pr
    JOIN policy_bindings pb ON pb.policy_rule_id = pr.id
    WHERE pr.organization_id = ${orgId}::uuid
      AND pr.resource_type = ${resourceType}::"PolicyResourceType"
      AND pr.action = ${action}::"PolicyAction"
      AND pr.scope_id IN (${Prisma.join(scopeIdList)})
    ORDER BY pr.priority ASC
  `)

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

export const checkPolicyBatch = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  checks: Array<{ resourceType: PolicyResourceType; action: PolicyAction }>,
): Promise<PolicyDecision[]> => {
  // For batch checks, we could optimize by loading all rules once.
  // For now, sequential evaluation is correct and simple.
  const results: PolicyDecision[] = []
  for (const check of checks) {
    results.push(await checkPolicy(prisma, actorContext, check.resourceType, check.action))
  }
  return results
}

export const getEffectivePolicy = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  resourceTypes?: PolicyResourceType[],
  actions?: PolicyAction[],
) => {
  const allResourceTypes: PolicyResourceType[] = resourceTypes ?? [
    'agent', 'channel', 'project', 'tool', 'session', 'task',
    'review', 'approval', 'admin', 'secret',
  ]
  const allActions: PolicyAction[] = actions ?? [
    'view', 'invoke', 'create', 'edit', 'assign', 'approve',
    'review', 'search', 'admin', 'bind',
  ]

  const decisions: Array<{
    resourceType: PolicyResourceType
    action: PolicyAction
    decision: PolicyDecision
  }> = []

  for (const resourceType of allResourceTypes) {
    for (const action of allActions) {
      const decision = await checkPolicy(prisma, actorContext, resourceType, action)
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
    limit?: number
  },
) => {
  const limit = Math.min(filters?.limit ?? 50, 200)
  const where: Record<string, unknown> = { organizationId }
  if (filters?.scope) where['scope'] = filters.scope
  if (filters?.scopeId) where['scopeId'] = filters.scopeId
  if (filters?.resourceType) where['resourceType'] = filters.resourceType
  if (filters?.cursor) where['id'] = { gt: filters.cursor }

  const rules = await prisma.policyRule.findMany({
    where: where as Prisma.PolicyRuleWhereInput,
    include: { bindings: true },
    orderBy: { createdAt: 'asc' },
    take: limit + 1,
  })

  const hasMore = rules.length > limit
  const data = hasMore ? rules.slice(0, limit) : rules

  return {
    data: data.map(mapPolicyRule),
    meta: {
      cursor: hasMore && data.length > 0 ? data.at(-1)!.id : null,
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
  actorType: string,
  actorId: string,
) => {
  const binding = await prisma.policyBinding.create({
    data: { policyRuleId: ruleId, actorType, actorId },
  })
  return { id: binding.id, actorType: binding.actorType, actorId: binding.actorId }
}

export const removePolicyBinding = async (
  prisma: PrismaClient,
  bindingId: string,
) => {
  await prisma.policyBinding.delete({ where: { id: bindingId } })
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

export const seedDefaultPolicies = async (
  prisma: PrismaClient,
  organizationId: string,
  createdBy: string,
) => {
  const existing = await prisma.policyRule.count({ where: { organizationId } })
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
