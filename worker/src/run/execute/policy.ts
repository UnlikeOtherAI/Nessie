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
import {
  buildScopeChain,
  resolveDecision,
  type PolicyRuleRow,
} from '@nessie/workspace-admin'
import { summarizeToolInput } from '../tool-util.js'
import type { ToolDenialReason } from '../tool-policy.js'
import type { RunContext } from './types.js'

// The worker's tool-invoke gate shares the one policy evaluator in
// `@nessie/workspace-admin` (security boundary hardening, Workstream 5).
// What stays here is only the adapter: the prisma-model fetch, the
// per-binding row normalization, and the verdict mapping into the worker's
// denial vocabulary. The scope chain comes from the shared `buildScopeChain`
// with the run's channel/agent/tool ids passed as additional scope ids, and
// the evaluation runs with the worker's options — allow-by-default plus the
// run's approval proof — so every behavioural difference from the API's
// interactive check is a stated option, not a forked loop.

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

// One resolution per binding, matching the flattened `$queryRaw` rows the
// API evaluator consumes.
const toPolicyRuleRows = (rules: WorkerPolicyRule[]): PolicyRuleRow[] =>
  rules.flatMap((rule) =>
    rule.bindings.map((binding) => ({
      action: rule.action,
      actorId: binding.actorId,
      actorType: binding.actorType,
      conditions: rule.conditions,
      effect: rule.effect,
      id: rule.id,
      priority: rule.priority,
      resourceType: rule.resourceType,
      scope: rule.scope,
      scopeId: rule.scopeId,
    })),
  )

export const evaluateToolInvokePolicy = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  context: RunContext,
  toolName: string,
): Promise<ToolPolicyEvaluation> => {
  const chain = buildScopeChain(actorContext, {
    agentId: context.agent.id,
    channelId: context.channel.id,
    toolId: toolName,
  })

  const rules = (await prisma.policyRule.findMany({
    where: {
      action: 'invoke',
      organizationId: context.channel.organizationId,
      resourceType: 'tool',
      scopeId: { in: chain.scopeIds },
    },
    include: { bindings: true },
    orderBy: [{ priority: 'asc' }],
  })) as WorkerPolicyRule[]

  const decision = resolveDecision(toPolicyRuleRows(rules), chain, {
    approvalProof: actorContext.approval?.approvalProof ?? null,
    defaultVerdict: 'allow',
  })

  if (decision.allowed) {
    return {
      allowed: true,
      policyRuleId: decision.policyRuleId,
      policySource: decision.policySource,
    }
  }

  return {
    allowed: false,
    approvalActionType: decision.approvalActionType,
    policyRuleId: decision.policyRuleId,
    policySource: decision.policySource,
    reason:
      decision.reasonCode === 'APPROVAL_REQUIRED'
        ? 'approval_required'
        : 'explicit_policy_deny',
  }
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
  if (
    actorContext.actionContext.taskId
    && actorContext.actionContext.taskId !== context.task.id
  ) {
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
