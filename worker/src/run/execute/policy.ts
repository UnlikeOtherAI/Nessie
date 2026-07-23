import { Prisma, type PrismaClient } from '@prisma/client'
import { writeAuditEntry } from '@nessie/db'
import {
  parseAgentId,
  parseChannelId,
  parseTaskId,
  parseThreadId,
  withActionContext,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { summarizeToolInput } from '../tool-util.js'
import type { ToolDenialReason } from '../tool-policy.js'
import type { RunContext } from './types.js'

const POLICY_SCOPE_WEIGHT: Record<string, number> = {
  organization: 0,
  project: 1,
  team: 2,
  channel: 3,
  agent: 4,
  tool: 5,
  user: 6,
}

type WorkerPolicyRule = {
  action: string
  bindings: Array<{
    actorId: string
    actorType: string
  }>
  conditions: unknown
  effect: string
  id: string
  priority: number
  resourceType: string
  scope: string
  scopeId: string
}

type ToolPolicyEvaluation =
  | {
      allowed: true
      policyRuleId?: string
      policySource: string
    }
  | {
      allowed: false
      approvalActionType?: string
      policyRuleId?: string
      policySource: string
      reason: 'approval_required' | 'explicit_policy_deny'
    }

type ToolDeniedOutputReason =
  | ToolDenialReason
  | 'approval_required'
  | 'explicit_policy_deny'

export const buildToolActorContext = (
  actorContext: AuthorizedActionContext,
  context: RunContext,
  toolName: string,
): AuthorizedActionContext =>
  withActionContext(actorContext, {
    agentId: parseAgentId(context.agent.id),
    channelId: parseChannelId(context.channel.id),
    taskId: parseTaskId(context.task.id),
    threadId: parseThreadId(context.run.threadId),
    toolId: toolName,
  })

const evaluatePolicyConditions = (conditions: Record<string, unknown> | null): boolean => {
  if (!conditions) {
    return true
  }

  const timeWindow = conditions['timeWindow']
  if (timeWindow && typeof timeWindow === 'object' && !Array.isArray(timeWindow)) {
    const candidate = timeWindow as {
      daysOfWeek?: unknown
      endHour?: unknown
      startHour?: unknown
    }
    if (
      typeof candidate.startHour !== 'number'
      || typeof candidate.endHour !== 'number'
      || !Array.isArray(candidate.daysOfWeek)
    ) {
      return false
    }

    const now = new Date()
    const hour = now.getUTCHours()
    const day = now.getUTCDay()
    if (!candidate.daysOfWeek.includes(day)) {
      return false
    }
    if (candidate.startHour <= candidate.endHour) {
      return hour >= candidate.startHour && hour < candidate.endHour
    }
    return hour >= candidate.startHour || hour < candidate.endHour
  }

  return true
}

const actorMatchesPolicyBinding = (
  actorContext: AuthorizedActionContext,
  context: RunContext,
  binding: WorkerPolicyRule['bindings'][number],
): boolean => {
  if (binding.actorId === '*') {
    return true
  }
  if (
    binding.actorType === actorContext.actor.actorType
    && binding.actorId === actorContext.actor.actorId
  ) {
    return true
  }
  if (binding.actorType === 'role' && actorContext.actor.roles?.includes(binding.actorId)) {
    return true
  }
  if (binding.actorType === 'agent' && binding.actorId === context.agent.id) {
    return true
  }
  return false
}

const buildPolicyScopeIds = (
  actorContext: AuthorizedActionContext,
  context: RunContext,
  toolName: string,
): string[] => [
  actorContext.tenant.organizationId,
  ...(actorContext.tenant.projectId ? [actorContext.tenant.projectId] : []),
  ...(actorContext.tenant.teamId ? [actorContext.tenant.teamId] : []),
  context.channel.id,
  context.agent.id,
  toolName,
  actorContext.actor.actorId,
]

export const evaluateToolInvokePolicy = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  context: RunContext,
  toolName: string,
): Promise<ToolPolicyEvaluation> => {
  const rules = await prisma.policyRule.findMany({
    where: {
      action: 'invoke',
      organizationId: context.channel.organizationId,
      resourceType: 'tool',
      scopeId: { in: buildPolicyScopeIds(actorContext, context, toolName) },
    },
    include: { bindings: true },
    orderBy: [{ priority: 'asc' }],
  }) as WorkerPolicyRule[]

  const matchingRules = rules
    .filter((rule) =>
      rule.bindings.some((binding) => actorMatchesPolicyBinding(actorContext, context, binding)),
    )
    .sort((left, right) => {
      const leftWeight = POLICY_SCOPE_WEIGHT[left.scope] ?? 99
      const rightWeight = POLICY_SCOPE_WEIGHT[right.scope] ?? 99
      if (leftWeight !== rightWeight) {
        return leftWeight - rightWeight
      }
      return left.priority - right.priority
    })

  let lastAllow: WorkerPolicyRule | null = null
  for (const rule of matchingRules) {
    const conditions = rule.conditions as Record<string, unknown> | null
    if (!evaluatePolicyConditions(conditions)) {
      continue
    }

    if (rule.effect === 'deny') {
      return {
        allowed: false,
        policyRuleId: rule.id,
        policySource: `${rule.scope}:${rule.scopeId}/deny`,
        reason: 'explicit_policy_deny',
      }
    }

    if (rule.effect === 'allow') {
      if (conditions?.['requiresApproval'] && !actorContext.approval?.approvalProof) {
        return {
          allowed: false,
          approvalActionType:
            typeof conditions['approvalActionType'] === 'string'
              ? conditions['approvalActionType']
              : undefined,
          policyRuleId: rule.id,
          policySource: `${rule.scope}:${rule.scopeId}/allow`,
          reason: 'approval_required',
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
    }
  }

  return { allowed: true, policySource: 'none' }
}

export const emitWorkerAuditEvent = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: {
    action: 'policy.evaluated'
    metadata?: Record<string, unknown>
    outcome: 'denied' | 'error' | 'success'
    reason?: string
    resourceId?: string
    resourceType: string
    tenantOverride?: {
      channelId?: string | null
      organizationId: string
      projectId?: string | null
      teamId?: string | null
    }
  },
): Promise<void> => {
  try {
    await writeAuditEntry(prisma, {
      action: input.action,
      actorId: actorContext.actor.actorId,
      actorType: actorContext.actor.actorType as 'user' | 'agent' | 'service' | 'system',
      channelId:
        input.tenantOverride?.channelId
        ?? actorContext.actionContext.channelId
        ?? actorContext.tenant.channelId
        ?? null,
      metadata: (input.metadata as Prisma.InputJsonValue | undefined) ?? null,
      organizationId: input.tenantOverride?.organizationId ?? actorContext.tenant.organizationId,
      outcome: input.outcome,
      projectId: input.tenantOverride?.projectId ?? actorContext.tenant.projectId ?? null,
      reason: input.reason ?? null,
      requestId: actorContext.actionContext.requestId,
      resourceId: input.resourceId ?? null,
      resourceType: input.resourceType,
      teamId:
        input.tenantOverride?.teamId
        ?? actorContext.tenant.teamId
        ?? actorContext.actionContext.teamId
        ?? null,
    })
  } catch {
    console.error('[worker:audit] Failed to emit audit event:', input.action, input.resourceType)
  }
}

export const validateRunActorContext = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  context: RunContext,
): Promise<void> => {
  const mismatches: string[] = []

  if (actorContext.tenant.organizationId !== context.channel.organizationId) {
    mismatches.push('tenant.organizationId')
  }
  if (actorContext.tenant.channelId && actorContext.tenant.channelId !== context.channel.id) {
    mismatches.push('tenant.channelId')
  }
  if (
    actorContext.actionContext.channelId
    && actorContext.actionContext.channelId !== context.channel.id
  ) {
    mismatches.push('actionContext.channelId')
  }
  if (
    actorContext.actionContext.agentId
    && actorContext.actionContext.agentId !== context.agent.id
  ) {
    mismatches.push('actionContext.agentId')
  }
  if (actorContext.actionContext.taskId && actorContext.actionContext.taskId !== context.task.id) {
    mismatches.push('actionContext.taskId')
  }
  if (
    actorContext.actionContext.threadId
    && actorContext.actionContext.threadId !== context.run.threadId
  ) {
    mismatches.push('actionContext.threadId')
  }

  if (mismatches.length === 0) {
    return
  }

  await emitWorkerAuditEvent(prisma, actorContext, {
    action: 'policy.evaluated',
    metadata: {
      agentId: context.agent.id,
      channelId: context.channel.id,
      mismatches,
      runId: context.run.id,
      source: 'worker_actor_context_validation',
      taskId: context.task.id,
      threadId: context.run.threadId,
    },
    outcome: 'denied',
    reason: 'actor_context_mismatch',
    resourceId: context.run.id,
    resourceType: 'run',
    tenantOverride: {
      channelId: context.channel.id,
      organizationId: context.channel.organizationId,
      projectId: null,
      teamId: null,
    },
  })

  throw new Error('Actor context does not match the run execution context.')
}

export const toolDeniedResult = (
  toolName: string,
  args: Record<string, unknown>,
  input: {
    approvalActionType?: string
    message: string
    policyRuleId?: string
    policySource?: string
    reason: ToolDeniedOutputReason
  },
): { inputSummary: string; output: string; success: false } => ({
  inputSummary: summarizeToolInput(args),
  output: JSON.stringify({
    approvalActionType: input.approvalActionType,
    message: input.message,
    policyRuleId: input.policyRuleId,
    policySource: input.policySource,
    reason: input.reason,
    toolId: toolName,
    type: 'tool_denied',
  }),
  success: false,
})
