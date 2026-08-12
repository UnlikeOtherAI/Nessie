import { Prisma, type PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  PolicyAction,
  PolicyDecision,
  PolicyResourceType,
} from '@nessie/schemas'

// Policy evaluation (deny-overrides over the scope chain). It lives in the
// shared package because the personal assistant's provisioning tools have to
// ask the same question the routes ask — `agent`/`bind` is checked before a
// binding is written, whether the request came from a button or from chat.
// Policy authoring (CRUD, defaults seeding) stays in the API.

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

export type PolicyRuleRow = {
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

export type PolicyScopeChain = {
  actorId: string
  actorRoles: string[]
  agentId?: string
  scopeIds: string[]
}

export const buildScopeChain = (
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
export const resolveDecision = (
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
export const loadRulesForChecks = async (
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
