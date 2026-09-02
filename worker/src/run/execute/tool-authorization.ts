import { BUILTIN_TOOL_DEFINITIONS, DEEP_WATER_START_FAILURE_DETAIL } from '@nessie/runtime'
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
  /**
   * A structural approval requirement the policy chain cannot express.
   *
   * `evaluateToolInvokePolicy` defaults to **allow** when no rule matches, and
   * default seeding writes no rule for sending mail — so an outbound email gate
   * that lived only in `PolicyRule` rows would be absent in every organisation
   * that never configured one. A tool whose blast radius leaves the workspace
   * therefore states its own requirement here, and the hook is consulted after
   * the policy verdict so a *consumed* approval proof still lets the resumed
   * call through instead of re-parking forever.
   */
  forceApproval?: (input: {
    toolName: string
    args: Record<string, unknown>
  }) => Promise<{
    approvalActionType: string
    expiryMs?: number
    requiredApproverUserId?: string | null
    /**
     * Server-authored facts the approver is shown. For a send this carries the
     * *resolved* recipients — a reply passes no `to` at all, so the raw
     * arguments alone would show an approver an empty recipient list.
     */
    contextExtra?: Record<string, unknown>
  } | null>
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

  const policyDecision = await evaluateToolInvokePolicy(
    prisma,
    toolActorContext,
    context,
    toolName,
    args,
    { consumeApprovalProof: auth.consumeApprovalProof },
  )

  // A structural gate only applies to a call the policy chain *allowed* and
  // that carries no verified approval proof: an approved, resumed call arrives
  // here allowed with its proof already consumed, and re-parking it would loop.
  let structural: Awaited<ReturnType<NonNullable<typeof auth.forceApproval>>> = null
  if (policyDecision.allowed && auth.forceApproval && !toolActorContext.approval?.approvalProof) {
    structural = await auth.forceApproval({ args, toolName })
  }
  if (structural && auth.maySuspendForApproval && auth.resumeState) {
    const approval = await createToolApprovalRequest(prisma, {
      actorContext: auth.resumeState.actorContext,
      approvalActionType: structural.approvalActionType,
      args,
      context,
      contextExtra: structural.contextExtra,
      expiryMs: structural.expiryMs,
      interactive: auth.resumeState.interactive,
      messageId: auth.resumeState.messageId,
      requiredApproverUserId: structural.requiredApproverUserId ?? null,
      toolCallId,
      toolName,
    })
    return { approval: { id: approval.id, toolName }, decision: 'suspend' }
  }
  if (structural) {
    // Nowhere to park it — an unattended run with no durable suspension point.
    // Refusing is the only safe answer: the alternative is sending unreviewed.
    return {
      decision: 'deny',
      result: toolDeniedResult(toolName, args, {
        approvalActionType: structural.approvalActionType,
        message: `Tool "${toolName}" requires approval before it can run.`,
        reason: 'approval_required',
      }),
    }
  }

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
    contextExtra?: Record<string, unknown>
    expiryMs?: number
    interactive: boolean
    messageId: string
    policyRuleId?: string
    requiredApproverUserId?: string | null
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
      ...(input.contextExtra ?? {}),
    } as Prisma.InputJsonValue,
    continuationToken: randomUUID(),
    // Email is asynchronous: an overnight send parked behind the 30-minute
    // default would expire before anyone woke up, stranding the conversation.
    expiresAt: new Date(Date.now() + (input.expiryMs ?? DEFAULT_APPROVAL_EXPIRY_MS)),
    organizationId: input.context.channel.organizationId,
    projectId: input.context.channel.projectId,
    reason: `Tool ${input.toolName} requires approval before it can run.`,
    requesterId: input.context.agent.id,
    requiredApproverUserId: input.requiredApproverUserId ?? null,
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
