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
//
// There is exactly one evaluator: the worker's tool-invoke gate resolves its
// prisma-model rows through the same `resolveDecision` core below, passing
// `defaultVerdict: 'allow'` plus the run's approval proof; API routes resolve
// flattened `$queryRaw` rows with the deny default. Only the row-fetch and
// verdict mapping differ, never the policy semantics (security boundary
// hardening, Workstream 5 / Sol CB-03).

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

export type PolicyEvaluationOptions = {
  /**
   * Set only by a caller that has already verified an approval request against
   * its organization, tool, canonical argument hash, and run lineage. A raw
   * token is deliberately not accepted here: this shared pure evaluator has no
   * database authority to decide whether an arbitrary non-empty string is a
   * proof. When false, every `requiresApproval` allow rule returns
   * APPROVAL_REQUIRED.
   */
  approvalSatisfied?: boolean
  /**
   * Verdict when no rule matches. API routes deny by default
   * (`NO_MATCHING_ALLOW`); the worker's tool-invoke gate allows by default
   * (`policySource: 'none'`), because the registry/grant gate that runs
   * before policy is its primary allowlist.
   */
  defaultVerdict?: 'deny' | 'allow'
}

// A malformed `timeWindow` fails closed (the rule never matches) in every
// mode: a caller who cannot spell the shape cannot satisfy it either.
const evaluateConditions = (
  conditions: Record<string, unknown> | null,
): boolean => {
  if (!conditions) return true

  const timeWindow = conditions['timeWindow']
  if (timeWindow) {
    if (typeof timeWindow !== 'object' || Array.isArray(timeWindow)) return false
    const tw = timeWindow as {
      daysOfWeek?: unknown
      endHour?: unknown
      startHour?: unknown
    }
    if (
      typeof tw.startHour !== 'number'
      || typeof tw.endHour !== 'number'
      || !Array.isArray(tw.daysOfWeek)
    ) {
      return false
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

// Whether one rule's binding targets this actor. The rule is already
// normalized to a single binding shape by the caller (flattened `$queryRaw`
// rows for the API, one resolution per prisma-model binding for the worker);
// the matching semantics are identical either way.
const bindingMatchesActor = (
  rule: Pick<PolicyRuleRow, 'actorId' | 'actorType'>,
  chain: PolicyScopeChain,
): boolean => {
  if (rule.actorId === '*') return true
  if (rule.actorType === 'user' && rule.actorId === chain.actorId) return true
  if (rule.actorType === 'role' && chain.actorRoles.includes(rule.actorId)) return true
  if (rule.actorType === 'agent' && rule.actorId === chain.agentId) return true
  return false
}

// The shared deny-overrides resolution over normalized rows. Both callers —
// the API's `resolveDecision` and the worker's tool-invoke adapter — run
// exactly this loop; the evaluation options carry the only intentional
// differences (default verdict and approval proof).
const resolveRules = (
  rules: PolicyRuleRow[],
  chain: PolicyScopeChain,
  options?: PolicyEvaluationOptions,
): PolicyDecision => {
  const approvalSatisfied = options?.approvalSatisfied === true

  const matchingRules = rules.filter((rule) => bindingMatchesActor(rule, chain))

  // Sort by scope weight then priority
  matchingRules.sort((a, b) => {
    const wa = SCOPE_WEIGHT[a.scope] ?? 99
    const wb = SCOPE_WEIGHT[b.scope] ?? 99
    if (wa !== wb) return wa - wb
    return a.priority - b.priority
  })

  // Deny-first evaluation
  let lastAllow: PolicyRuleRow | null = null
  let lastAllowUsedApproval = false
  let lastAllowReviewMode: 'auto' | undefined

  for (const rule of matchingRules) {
    const conditions = rule.conditions as Record<string, unknown> | null
    if (!evaluateConditions(conditions)) continue

    if (rule.effect === 'deny') {
      return {
        allowed: false,
        policyRuleId: rule.id,
        policySource: `${rule.scope}:${rule.scopeId}/deny`,
        reasonCode: 'EXPLICIT_DENY',
      }
    }

    if (rule.effect === 'allow') {
      if (conditions?.['requiresApproval'] && !approvalSatisfied) {
        return {
          allowed: false,
          policyRuleId: rule.id,
          policySource: `${rule.scope}:${rule.scopeId}/allow`,
          reasonCode: 'APPROVAL_REQUIRED',
          requiresApproval: true,
          approvalActionType:
            typeof conditions['approvalActionType'] === 'string'
              ? conditions['approvalActionType']
              : undefined,
        }
      }
      if (conditions?.['requiresApproval']) {
        lastAllow = rule
        lastAllowUsedApproval = true
        lastAllowReviewMode = conditions['reviewMode'] === 'auto' ? 'auto' : undefined
        continue
      }
      lastAllow = rule
      lastAllowUsedApproval = false
      lastAllowReviewMode = conditions?.['reviewMode'] === 'auto' ? 'auto' : undefined
    }
  }

  if (lastAllow) {
    return {
      allowed: true,
      policyRuleId: lastAllow.id,
      policySource: `${lastAllow.scope}:${lastAllow.scopeId}/allow`,
      reasonCode: 'ALLOWED',
      ...(lastAllowUsedApproval ? { approvalProofUsed: true } : {}),
      ...(lastAllowReviewMode ? { reviewMode: lastAllowReviewMode } : {}),
    }
  }

  if (options?.defaultVerdict === 'allow') {
    return { allowed: true, policySource: 'none', reasonCode: 'ALLOWED' }
  }

  return {
    allowed: false,
    policySource: 'none',
    reasonCode: 'NO_MATCHING_ALLOW',
  }
}

// Evaluate pre-fetched rules (already filtered to the org + scope chain) for one
// resourceType/action pair using the deny-overrides resolution.
export const resolveDecision = (
  rules: PolicyRuleRow[],
  chain: PolicyScopeChain,
  options?: PolicyEvaluationOptions,
): PolicyDecision => resolveRules(rules, chain, options)

export type ToolApprovalProofInput = {
  approvalId: string | undefined
  argsHash: string
  continuationRunId: string
  organizationId: string
  proof: string | undefined
  toolName: string
}

/**
 * Validate the stored, server-minted proof before the pure evaluator sees an
 * approval signal. A direct `continuationOfRunId` check is deliberately
 * stronger than a broad organization match: the proof belongs only to the
 * continuation spawned from its own suspended run.
 */
export const verifyToolApprovalProof = async (
  prisma: PrismaClient,
  input: ToolApprovalProofInput,
): Promise<{ id: string; requiredApproverUserId: string | null } | null> => {
  if (!input.approvalId || !input.proof) return null
  const approval = await prisma.approvalRequest.findFirst({
    where: {
      action: 'tool.invoke',
      argsHash: input.argsHash,
      continuationToken: input.proof,
      id: input.approvalId,
      organizationId: input.organizationId,
      proofConsumedAt: null,
      status: 'approved',
      toolName: input.toolName,
    },
    select: { id: true, requiredApproverUserId: true, runId: true },
  })
  if (!approval?.runId) return null
  const run = await prisma.run.findUnique({
    where: { id: input.continuationRunId },
    select: { continuationOfRunId: true },
  })
  return run?.continuationOfRunId === approval.runId
    ? { id: approval.id, requiredApproverUserId: approval.requiredApproverUserId }
    : null
}

/** Claim an already verified proof at the exact dispatch point; false means a race consumed it. */
export const consumeToolApprovalProof = async (
  prisma: PrismaClient,
  input: ToolApprovalProofInput & { approvalId: string; proof: string },
): Promise<boolean> => {
  const consumed = await prisma.approvalRequest.updateMany({
    where: {
      action: 'tool.invoke',
      argsHash: input.argsHash,
      continuationToken: input.proof,
      id: input.approvalId,
      organizationId: input.organizationId,
      proofConsumedAt: null,
      status: 'approved',
      toolName: input.toolName,
    },
    data: { proofConsumedAt: new Date() },
  })
  return consumed.count === 1
}

export const checkPolicy = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  resourceType: PolicyResourceType,
  action: PolicyAction,
  additionalScopeIds?: { agentId?: string; channelId?: string; toolId?: string },
  options?: PolicyEvaluationOptions,
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

  return resolveRules(rules, chain, options)
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
