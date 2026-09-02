import {
  BUILTIN_TOOL_DEFINITIONS,
  DEEP_WATER_START_FAILURE_DETAIL,
  STRUCTURALLY_APPROVAL_GATED_TOOL_IDS,
} from '@nessie/runtime'
import { resolveStandingConsentForToolCall } from '@nessie/workspace-admin'
import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { authorizeToolCall } from '../tool-policy.js'
import { hashJsonValue, summarizeToolInput } from '../tool-util.js'
import type { DeepWaterHandoffGuard } from '../deepwater-handoff-guard.js'
import type { AgenticToolResult } from '../tools.js'
import {
  buildToolActorContext,
  emitWorkerAuditEvent,
  evaluateToolInvokePolicy,
  toolDeniedResult,
} from './policy.js'
import type { RunContext } from './types.js'

export type ToolActorContext = AuthorizedActionContext

export type ToolAuthorizationDecision =
  | {
      decision: 'allow'
      toolActorContext: ToolActorContext
    }
  | {
      decision: 'deny'
      result: AgenticToolResult
    }
  | {
      decision: 'suspend'
      approval: {
        id: string
        toolName: string
      }
    }

export type ToolAuthorizationContext = {
  agentKind: RunContext['agent']['agentKind']
  allowedToolIds: Set<string>
  /**
   * Registry membership is the organisational ceiling; this per-run set is
   * the resolved offer after agent capability gates such as todosEnabled.
   */
  resolvedBuiltinToolIds?: Set<string>
  /**
   * Names dispatched outside the builtin registry (MCP views, the executor
   * toolset, and worker-owned meta tools such as `tool_spec`). The
   * registry/grant gate only judges registered builtin ids — external names
   * skip it and still pass the policy/approval evaluation.
   */
  externalToolNames?: Set<string>
  parentAgentId: string | null
  /** Only a top-level, non-handoff run has a durable identity to suspend. */
  maySuspendForApproval: boolean
  /** Preflight verifies a proof but leaves its one-time claim for dispatch. */
  consumeApprovalProof?: boolean
  resumeState?: {
    actorContext: AuthorizedActionContext
    interactive: boolean
    messageId: string
  }
  toolPolicy: Record<string, boolean> | null
}

export type ToolAuthorizationAuditEmitter = (
  actorContext: AuthorizedActionContext,
  input: Parameters<typeof emitWorkerAuditEvent>[2],
) => Promise<void>

export type ToolAuthorizationHooks = {
  deepWaterHandoffGuard: DeepWaterHandoffGuard
  // Audit defaults to `emitWorkerAuditEvent` in `authorizeToolExecution`; the
  // seam exists so flows whose audit identity is out of scope for this change
  // (the delegate sub-agent) keep their previous recording behaviour exactly.
  emitAudit?: ToolAuthorizationAuditEmitter
}

const auditDenial = async (
  emitAudit: ToolAuthorizationAuditEmitter,
  actorContext: AuthorizedActionContext,
  context: RunContext,
  toolName: string,
  metadata: Record<string, unknown>,
  reason: string,
): Promise<void> => {
  await emitAudit(actorContext, {
    action: 'policy.evaluated',
    metadata: {
      agentId: context.agent.id,
      runId: context.run.id,
      taskId: context.task.id,
      toolId: toolName,
      ...metadata,
    },
    outcome: 'denied',
    reason,
    resourceId: toolName,
    resourceType: 'tool',
  })
}

/**
 * The one pre-dispatch authorization gate every tool execution passes
 * through: DeepWater handoff suppression, then the registry/grant gate, then
 * the policy/approval evaluation. An allow dispatch shape is returned only
 * after all three have passed, so callers can dispatch any tool name —
 * `delegate`, MCP names, executor names, builtins — with authorization
 * already decided. On a deny, the structured tool-error output is emitted
 * here together with the audit record, and the caller must return it
 * without dispatching. The actor context is rebuilt for the actual tool
 * name, which matters for nested calls: a sub-agent's builtin is authorized
 * as itself, never under the outer `delegate` context.
 */
export const authorizeToolExecution = async (
  prisma: PrismaClient,
  baseActorContext: AuthorizedActionContext,
  context: RunContext,
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string,
  auth: ToolAuthorizationContext,
  hooks: ToolAuthorizationHooks,
): Promise<ToolAuthorizationDecision> => {
  const toolActorContext = buildToolActorContext(baseActorContext, context, toolName)
  const emitAudit: ToolAuthorizationAuditEmitter =
    hooks.emitAudit ?? ((actorContext, input) => emitWorkerAuditEvent(prisma, actorContext, input))

  if (await hooks.deepWaterHandoffGuard.suppressBuiltin(toolName)) {
    return {
      decision: 'deny',
      result: {
        inputSummary: summarizeToolInput(args),
        output: DEEP_WATER_START_FAILURE_DETAIL,
        success: false,
      },
    }
  }

  const isExternalName = auth.externalToolNames?.has(toolName) ?? false
  const resolvedBuiltinToolIds = auth.resolvedBuiltinToolIds ?? auth.allowedToolIds
  const registryDecision = isExternalName
    ? ({ allowed: true } as const)
    : authorizeToolCall(
      toolName,
      auth.allowedToolIds,
      BUILTIN_TOOL_DEFINITIONS,
      auth.toolPolicy,
      auth.parentAgentId,
      auth.agentKind,
    )

  if (
    !registryDecision.allowed
    || (!isExternalName && !auth.allowedToolIds.has(toolName))
    || (!isExternalName && !resolvedBuiltinToolIds.has(toolName))
  ) {
    const reason = registryDecision.allowed ? 'tool_not_granted' : registryDecision.reason
    await auditDenial(emitAudit, toolActorContext, context, toolName, {
      source: 'worker_tool_authorization',
    }, reason)
    return {
      decision: 'deny',
      result: toolDeniedResult(toolName, args, {
        message: `Tool "${toolName}" is not allowed for this agent.`,
        reason,
      }),
    }
  }

  const rawPolicyDecision = await evaluateToolInvokePolicy(
    prisma,
    toolActorContext,
    context,
    toolName,
    args,
    { consumeApprovalProof: auth.consumeApprovalProof },
  )

  // A tool may declare its approval requirement in CODE rather than relying on
  // a `PolicyRule` row. The evaluator's default verdict is `allow`, so a purely
  // data-driven gate is simply absent in any organization whose seed never ran
  // — which is every organization created before the rule existed. Sending mail
  // as a person is not something that may be ungated by accident.
  //
  // The one legitimate bypass is standing consent the mailbox owner gave for
  // this exact agent, resolved here so the decision lives at the chokepoint
  // every tool execution passes through rather than in each handler.
  const policyDecision = await (async () => {
    if (
      !rawPolicyDecision.allowed
      || !STRUCTURALLY_APPROVAL_GATED_TOOL_IDS.has(toolName)
      || toolActorContext.approval?.approvalProof
    ) {
      return rawPolicyDecision
    }
    const consented = await resolveStandingConsentForToolCall(prisma, {
      toolName,
      args,
      organizationId: context.channel.organizationId,
      agentId: context.agent.id,
      requestingUserId: toolActorContext.actionContext.effectiveUserId ?? null,
      interactive: auth.resumeState?.interactive ?? false,
    })
    if (consented) return rawPolicyDecision
    return {
      ...rawPolicyDecision,
      allowed: false as const,
      reason: 'approval_required' as const,
    }
  })()

  if (!policyDecision.allowed) {
    await auditDenial(emitAudit, toolActorContext, context, toolName, {
      approvalActionType: policyDecision.approvalActionType,
      policyRuleId: policyDecision.policyRuleId,
      policySource: policyDecision.policySource,
      source: 'worker_tool_policy',
    }, policyDecision.reason)
    if (policyDecision.reason === 'approval_required' && auth.maySuspendForApproval && auth.resumeState) {
      const approval = await createToolApprovalRequest(prisma, {
        actorContext: auth.resumeState.actorContext,
        approvalActionType: policyDecision.approvalActionType,
        args,
        context,
        policyRuleId: policyDecision.policyRuleId,
        toolCallId,
        toolName,
        interactive: auth.resumeState.interactive,
        messageId: auth.resumeState.messageId,
      })
      return { decision: 'suspend', approval: { id: approval.id, toolName } }
    }
    return {
      decision: 'deny',
      result: toolDeniedResult(toolName, args, {
        approvalActionType: policyDecision.approvalActionType,
        message:
          policyDecision.reason === 'approval_required'
            ? `Tool "${toolName}" requires approval before it can run.`
            : `Tool "${toolName}" was denied by policy.`,
        policyRuleId: policyDecision.policyRuleId,
        policySource: policyDecision.policySource,
        reason: policyDecision.reason,
      }),
    }
  }

  return { decision: 'allow', toolActorContext }
}

const DEFAULT_APPROVAL_EXPIRY_MS = 30 * 60 * 1000

/**
 * A mailbox action waits far longer than a routine tool gate.
 *
 * Thirty minutes is a sensible window for something a person is watching
 * happen. It is the wrong window for "your assistant wants to send this email"
 * raised at 06:00 by a schedule: the request would be dead before anyone woke
 * up, and the plan called that failure out explicitly. Twenty-four hours is
 * long enough to survive a night and short enough that a forgotten request
 * does not linger indefinitely.
 */
const MAILBOX_APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000

const approvalExpiryFor = (toolName: string): number =>
  STRUCTURALLY_APPROVAL_GATED_TOOL_IDS.has(toolName)
    ? MAILBOX_APPROVAL_EXPIRY_MS
    : DEFAULT_APPROVAL_EXPIRY_MS

/**
 * The partial `(run_id, tool_call_id)` unique index is the crash-redelivery
 * boundary. Prisma cannot name a partial unique selector, so look up first and
 * re-read after a unique-conflict race.
 */
const createToolApprovalRequest = async (
  prisma: PrismaClient,
  input: {
    actorContext: AuthorizedActionContext
    approvalActionType?: string
    args: Record<string, unknown>
    context: RunContext
    interactive: boolean
    messageId: string
    policyRuleId?: string
    toolCallId: string
    toolName: string
  },
): Promise<{ id: string }> => {
  const existing = await prisma.approvalRequest.findFirst({
    where: { runId: input.context.run.id, toolCallId: input.toolCallId },
    select: { id: true },
  })
  if (existing) return existing

  const data = {
    action: 'tool.invoke',
    agentId: input.context.agent.id,
    argsHash: hashJsonValue(input.args),
    channelId: input.context.channel.id,
    context: {
      approvalActionType: input.approvalActionType ?? null,
      inputSummary: summarizeToolInput(input.args),
      policyRuleId: input.policyRuleId ?? null,
      toolName: input.toolName,
    } as Prisma.InputJsonValue,
    continuationToken: randomUUID(),
    expiresAt: new Date(Date.now() + approvalExpiryFor(input.toolName)),
    organizationId: input.context.channel.organizationId,
    projectId: input.context.channel.projectId,
    reason: `Tool ${input.toolName} requires approval before it can run.`,
    requesterId: input.context.agent.id,
    // A send-as-you gate is resolvable ONLY by the person whose account it
    // acts as. Approval visibility otherwise reaches any member who can read a
    // public channel, so without this a colleague could authorise an email
    // sent in somebody else's name.
    requiredApproverUserId:
      STRUCTURALLY_APPROVAL_GATED_TOOL_IDS.has(input.toolName)
        ? input.actorContext.actionContext.effectiveUserId ?? null
        : null,
    resumeState: {
      actorContext: input.actorContext,
      args: input.args,
      interactive: input.interactive,
      messageId: input.messageId,
    } as Prisma.InputJsonValue,
    runId: input.context.run.id,
    taskId: input.context.task.id,
    teamId: input.context.channel.teamId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
  }
  try {
    return await prisma.approvalRequest.create({ data, select: { id: true } })
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error
    }
    const raced = await prisma.approvalRequest.findFirst({
      where: { runId: input.context.run.id, toolCallId: input.toolCallId },
      select: { id: true },
    })
    if (!raced) throw error
    return raced
  }
}
