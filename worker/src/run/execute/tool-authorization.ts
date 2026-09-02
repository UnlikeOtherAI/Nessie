import {
  BUILTIN_TOOL_DEFINITIONS,
  DEEP_WATER_START_FAILURE_DETAIL,
  STRUCTURALLY_APPROVAL_GATED_TOOL_IDS,
} from '@nessie/runtime'
import {
  recordSendDecision,
  resolveStandingConsentForToolCall,
} from '@nessie/workspace-admin'
import {
  buildSendBoundaryPrompt,
  readSendBoundaryVerdict,
  type SendBoundaryVerdict,
} from './send-boundary-judge.js'
import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { authorizeToolCall } from '../tool-policy.js'
import { hashJsonValue, summarizeToolInput } from '../tool-util.js'
import {
  reviewableToolSurface,
  type AutoReviewResult,
  type ReviewableToolSurface,
} from './auto-review.js'
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
        notice: string
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
  /** The main loop's live view, including deferred MCP names loaded mid-run. */
  mcpToolNames?: ReadonlySet<string>
  /** The executor operations actually exposed for this run. */
  executorToolNames?: ReadonlySet<string>
  parentAgentId: string | null
  /** Only a top-level, non-handoff run has a durable identity to suspend. */
  maySuspendForApproval: boolean
  /**
   * The run's utility-model call, used for the send-boundary judgement. Absent
   * where no utility model resolves, which fails the judgement closed to
   * asking rather than proceeding unjudged.
   */
  runUtility?: (prompt: string) => Promise<string | null>
  /** Preflight verifies a proof but leaves its one-time claim for dispatch. */
  consumeApprovalProof?: boolean
  /** A prepared call has already received its single auto-review verdict. */
  skipAutoReview?: boolean
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
  /** One bounded utility-model review, supplied by the caller that owns metering. */
  reviewProposedAction?: (input: {
    args: Record<string, unknown>
    surface: ReviewableToolSurface
    toolName: string
  }) => Promise<AutoReviewResult>
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
  let boundaryReason: string | null = null
  const policyDecision = await (async () => {
    if (
      !rawPolicyDecision.allowed
      || !STRUCTURALLY_APPROVAL_GATED_TOOL_IDS.has(toolName)
      || toolActorContext.approval?.approvalProof
    ) {
      return rawPolicyDecision
    }
    const consent = await resolveStandingConsentForToolCall(prisma, {
      toolName,
      args,
      organizationId: context.channel.organizationId,
      agentId: context.agent.id,
      requestingUserId: toolActorContext.actionContext.effectiveUserId ?? null,
      interactive: auth.resumeState?.interactive ?? false,
    })
    // Keep the full denied shape: spreading an *allowed* decision would drop
    // `approvalActionType`, which the approval row and its card read.
    const escalate = () => ({
      ...rawPolicyDecision,
      allowed: false as const,
      approvalActionType: undefined as string | undefined,
      policyRuleId: undefined as string | undefined,
      reason: 'approval_required' as const,
    })
    if (consent.outcome === 'ask') return escalate()
    if (consent.outcome === 'proceed') return rawPolicyDecision

    // A `judged` grant is consent to DECIDE, not consent to send. One bounded
    // utility call weighs the action against the owner's own written boundary,
    // and fails closed to asking — the inverse of the watch-status gate,
    // because a miss there costs a redundant message and a miss here sends an
    // email nobody approved.
    const verdict = await judgeAgainstSendBoundary({
      args,
      boundary: consent.boundary,
      runUtility: auth.runUtility,
      toolName,
    })
    await recordSendDecision(
      prisma,
      consent.grantId,
      verdict.verdict === 'proceed' ? 'decided' : 'asked',
    ).catch(() => undefined)
    if (verdict.verdict === 'proceed') return rawPolicyDecision
    // Shown on the approval card: the person should see why they were asked.
    boundaryReason = verdict.reason
    return escalate()
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
        ...(boundaryReason ? { boundaryReason } : {}),
      })
      return {
        decision: 'suspend',
        approval: {
          id: approval.id,
          notice: `⚠️ I need approval before I can run ${toolName}.`,
          toolName,
        },
      }
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

  if (policyDecision.reviewMode === 'auto' && !auth.skipAutoReview) {
    const surface = reviewableToolSurface(toolName, {
      executorToolNames: auth.executorToolNames,
      mcpToolNames: auth.mcpToolNames,
    })
    if (surface) {
      const review = await runAutoReview(hooks, { args, surface, toolName })
      await recordAutoReview(prisma, emitAudit, toolActorContext, context, toolName, surface, review)

      if (review.verdict === 'deny') {
        return {
          decision: 'deny',
          result: toolDeniedResult(toolName, args, {
            message: `Automated review denied ${toolName}: ${review.reason}`,
            policyRuleId: policyDecision.policyRuleId,
            policySource: policyDecision.policySource,
            reason: 'auto_review_denied',
          }),
        }
      }

      if (review.verdict === 'require_approval') {
        const notice = `Automated review asked for approval before ${toolName}: ${review.reason}`
        if (auth.maySuspendForApproval && auth.resumeState) {
          const approval = await createToolApprovalRequest(prisma, {
            actorContext: auth.resumeState.actorContext,
            args,
            context,
            interactive: auth.resumeState.interactive,
            messageId: auth.resumeState.messageId,
            policyRuleId: policyDecision.policyRuleId,
            reason: notice,
            toolCallId,
            toolName,
          })
          return { decision: 'suspend', approval: { id: approval.id, notice, toolName } }
        }
        return {
          decision: 'deny',
          result: toolDeniedResult(toolName, args, {
            message: notice,
            policyRuleId: policyDecision.policyRuleId,
            policySource: policyDecision.policySource,
            reason: 'approval_required',
          }),
        }
      }
    }
  }

  return { decision: 'allow', toolActorContext }
}

/**
 * One bounded judgement, on the same utility-model plumbing compaction and the
 * watch-status gate already use. Every failure path returns `ask`.
 */
const judgeAgainstSendBoundary = async (input: {
  args: Record<string, unknown>
  boundary: string
  runUtility?: (prompt: string) => Promise<string | null>
  toolName: string
}): Promise<SendBoundaryVerdict> => {
  if (!input.runUtility) {
    return { verdict: 'ask', reason: 'I could not check this against your note.' }
  }
  try {
    const raw = await input.runUtility(
      buildSendBoundaryPrompt({
        boundary: input.boundary,
        proposal: `${input.toolName} with ${summarizeToolInput(input.args)}`,
        request: 'See the conversation this action came from.',
      }),
    )
    return readSendBoundaryVerdict(raw)
  } catch {
    return { verdict: 'ask', reason: 'I could not check this against your note.' }
  }
}

// Policy-declared auto-review sits alongside the boundary judge, deliberately.
// They answer different questions: this one is an organisation saying "review
// this class of action", the boundary judge is one person delegating their own
// mailbox. Both fail closed to a human.
const runAutoReview = async (
  hooks: ToolAuthorizationHooks,
  input: { args: Record<string, unknown>; surface: ReviewableToolSurface; toolName: string },
): Promise<AutoReviewResult> => {
  if (!hooks.reviewProposedAction) {
    return {
      reason: 'The automated reviewer was unavailable, so a human must decide.',
      reviewerModel: null,
      verdict: 'require_approval',
    }
  }
  try {
    return await hooks.reviewProposedAction(input)
  } catch {
    return {
      reason: 'The automated reviewer was unavailable, so a human must decide.',
      reviewerModel: null,
      verdict: 'require_approval',
    }
  }
}

const recordAutoReview = async (
  prisma: PrismaClient,
  emitAudit: ToolAuthorizationAuditEmitter,
  actorContext: AuthorizedActionContext,
  context: RunContext,
  toolName: string,
  surface: ReviewableToolSurface,
  review: AutoReviewResult,
): Promise<void> => {
  await prisma.taskEvent.create({
    data: {
      eventType: 'tool.auto_reviewed',
      payload: {
        surface,
        toolName,
        verdict: review.verdict,
      },
      taskId: context.task.id,
    },
  })
  await emitAudit(actorContext, {
    action: 'policy.evaluated',
    metadata: {
      agentId: context.agent.id,
      autoReview: {
        reviewerModel: review.reviewerModel,
        verdict: review.verdict,
      },
      runId: context.run.id,
      surface,
      taskId: context.task.id,
      toolId: toolName,
    },
    outcome: review.verdict === 'deny' ? 'denied' : 'success',
    ...(review.verdict === 'deny' ? { reason: 'auto_review_denied' } : {}),
    resourceId: toolName,
    resourceType: 'tool',
  })
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
    reason?: string
    toolCallId: string
    toolName: string
    /** Why the assistant escalated instead of deciding, when it judged. */
    boundaryReason?: string
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
      boundaryReason: input.boundaryReason ?? null,
    } as Prisma.InputJsonValue,
    continuationToken: randomUUID(),
    expiresAt: new Date(Date.now() + approvalExpiryFor(input.toolName)),
    organizationId: input.context.channel.organizationId,
    projectId: input.context.channel.projectId,
    reason: input.reason ?? `Tool ${input.toolName} requires approval before it can run.`,
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
