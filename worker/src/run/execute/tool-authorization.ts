import {
  BUILTIN_TOOL_DEFINITIONS,
  DEEP_WATER_START_FAILURE_DETAIL,
  GMAIL_DRAFT_SEND_TOOL_ID,
  hasStrictToolAuthorizationInput,
  parseToolAuthorizationArgs,
  STRUCTURALLY_APPROVAL_GATED_TOOL_IDS,
} from '@nessie/runtime'
import { recordSendDecision, resolveStandingConsentForToolCall } from '@nessie/team-admin'
import { type PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { authorizeToolCall } from '../tool-policy.js'
import { summarizeToolInputForTool } from '../tool-util.js'
import { reviewableToolSurface } from './auto-review.js'
import {
  auditToolAuthorizationDenial,
  claimVerifiedToolApprovalProof,
  createToolApprovalRequest,
  describeGatedAction,
  judgeAgainstSendBoundary,
  postAllowedByRuleCard,
  recordAutoReview,
  runAutoReview,
} from './tool-approval.js'
import {
  buildToolActorContext,
  emitWorkerAuditEvent,
  evaluateToolInvokePolicy,
  toolDeniedResult,
} from './policy.js'
import type { RunContext } from './types.js'
import { bindGmailDraftApprovalFingerprint } from './gmail-draft-approval.js'
import type {
  ToolAuthorizationAuditEmitter,
  ToolAuthorizationContext,
  ToolAuthorizationDecision,
  ToolAuthorizationHooks,
} from './tool-authorization-contract.js'

export type {
  ToolActorContext,
  ToolAuthorizationAuditEmitter,
  ToolAuthorizationContext,
  ToolAuthorizationDecision,
  ToolAuthorizationHooks,
} from './tool-authorization-contract.js'

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
  let canonicalArgs: Record<string, unknown>
  try {
    canonicalArgs = parseToolAuthorizationArgs(toolName, args)
  } catch {
    // These are credential-boundary tools. An unrecognised field can be a
    // password or authorization code, so it must not reach any durable sink.
    await auditToolAuthorizationDenial(emitAudit, toolActorContext, context, toolName, {
      source: 'worker_tool_authorization',
    }, 'invalid_tool_input')
    return {
      decision: 'deny',
      result: {
        inputSummary: 'Invalid tool input.',
        output: hasStrictToolAuthorizationInput(toolName)
          ? 'The tool arguments were invalid. Use only the documented fields.'
          : 'The tool arguments were invalid.',
        success: false,
      },
    }
  }

  if (toolName === GMAIL_DRAFT_SEND_TOOL_ID) {
    const approvedArgs = await bindGmailDraftApprovalFingerprint(
      prisma, toolActorContext, context.channel.organizationId, canonicalArgs,
    )
    if (!approvedArgs) {
      await auditToolAuthorizationDenial(emitAudit, toolActorContext, context, toolName, {
        source: 'worker_tool_authorization',
      }, 'invalid_tool_target')
      return {
        decision: 'deny',
        result: {
          inputSummary: 'Unavailable Gmail draft.',
          output: 'I cannot find that draft.',
          success: false,
        },
      }
    }
    canonicalArgs = approvedArgs
  }

  if (await hooks.deepWaterHandoffGuard.suppressBuiltin(toolName)) {
    return {
      decision: 'deny',
      result: {
        inputSummary: summarizeToolInputForTool(toolName, canonicalArgs),
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
      {
        ...(auth.identityToolIds ? { identityToolIds: auth.identityToolIds } : {}),
        // Read straight off the run context rather than threaded through every
        // caller: the same row toolset assembly consulted, so a stale schema
        // (a deferred stub, a replayed call, a resumed approval) cannot smuggle
        // `agent_handoff` back into a global agent's run.
        ...(context.agent.systemSlug ? { agentSystemSlug: context.agent.systemSlug } : {}),
      },
    )

  if (
    !registryDecision.allowed
    || (!isExternalName && !auth.allowedToolIds.has(toolName))
    || (!isExternalName && !resolvedBuiltinToolIds.has(toolName))
  ) {
    const reason = registryDecision.allowed ? 'tool_not_granted' : registryDecision.reason
    await auditToolAuthorizationDenial(emitAudit, toolActorContext, context, toolName, {
      source: 'worker_tool_authorization',
    }, reason)
    return {
      decision: 'deny',
      result: toolDeniedResult(toolName, canonicalArgs, {
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
    canonicalArgs,
    // Policy tells us whether a proof is valid, but the dispatch chokepoint
    // claims it only after every structural and auto-review gate has cleared.
    { consumeApprovalProof: false },
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
  let structuralApprover: string | null = null
  let structuralContext: Record<string, unknown> | null = null
  const structuralState: {
    denial: { message: string; reason: string } | null
  } = { denial: null }
  let structuralApprovalProofUsed = false
  const policyDecision = await (async () => {
    if (
      !rawPolicyDecision.allowed
      || !STRUCTURALLY_APPROVAL_GATED_TOOL_IDS.has(toolName)
      || rawPolicyDecision.approvalProofVerified
    ) {
      if (
        rawPolicyDecision.allowed
        && STRUCTURALLY_APPROVAL_GATED_TOOL_IDS.has(toolName)
        && rawPolicyDecision.approvalProofVerified
      ) {
        structuralApprovalProofUsed = true
      }
      return rawPolicyDecision
    }
    // A family that owns its own escalation answers first and is final for its
    // tools; standing consent is the send-as-you path and does not apply there.
    const familyDecision = auth.structuralGate
      ? await auth.structuralGate({ args: canonicalArgs, toolName })
      : null
    if (familyDecision) {
      if (familyDecision.outcome === 'allow') return rawPolicyDecision
      if (familyDecision.outcome === 'deny') {
        structuralState.denial = familyDecision
        return {
          ...rawPolicyDecision,
          allowed: false as const,
          approvalActionType: undefined as string | undefined,
          policyRuleId: undefined as string | undefined,
          reason: 'explicit_policy_deny' as const,
        }
      }
      boundaryReason = familyDecision.reason ?? null
      structuralApprover = familyDecision.requiredApproverUserId ?? null
      structuralContext = familyDecision.contextExtra ?? null
      return {
        ...rawPolicyDecision,
        allowed: false as const,
        approvalActionType: undefined as string | undefined,
        policyRuleId: undefined as string | undefined,
        reason: 'approval_required' as const,
      }
    }

    const consent = await resolveStandingConsentForToolCall(prisma, {
      toolName,
      args: canonicalArgs,
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
    if (consent.outcome === 'ask') {
      // A standing-consent rule is per Google connection. Keep the exact
      // connection the gate resolved with the approval rather than resolving a
      // person's active accounts again when they choose "don't ask again".
      structuralContext = consent.connectionId
        ? { approvedGoogleConnectionId: consent.connectionId }
        : null
      return escalate()
    }
    if (consent.outcome === 'proceed') {
      await postAllowedByRuleCard(prisma, context, toolActorContext, {
        args: canonicalArgs,
        rule: null,
        toolName,
      })
      return rawPolicyDecision
    }

    // A `judged` grant is consent to DECIDE, not consent to send. One bounded
    // utility call weighs the action against the owner's own written boundary,
    // and fails closed to asking — the inverse of the watch-status gate,
    // because a miss there costs a redundant message and a miss here sends an
    // email nobody approved.
    const verdict = await judgeAgainstSendBoundary({
      args: canonicalArgs,
      boundary: consent.boundary,
      runUtility: auth.runUtility,
      toolName,
    })
    await recordSendDecision(
      prisma,
      consent.grantId,
      verdict.verdict === 'proceed' ? 'decided' : 'asked',
    ).catch(() => undefined)
    if (verdict.verdict === 'proceed') {
      await postAllowedByRuleCard(prisma, context, toolActorContext, {
        args: canonicalArgs,
        rule: consent.boundary,
        toolName,
      })
      return rawPolicyDecision
    }
    // Shown on the approval card: the person should see why they were asked.
    boundaryReason = verdict.reason
    return escalate()
  })()

  if (!policyDecision.allowed) {
    await auditToolAuthorizationDenial(emitAudit, toolActorContext, context, toolName, {
      approvalActionType: policyDecision.approvalActionType,
      policyRuleId: policyDecision.policyRuleId,
      policySource: policyDecision.policySource,
      source: 'worker_tool_policy',
    }, structuralState.denial?.reason ?? policyDecision.reason)
    if (policyDecision.reason === 'approval_required' && auth.maySuspendForApproval && auth.resumeState) {
      const approval = await createToolApprovalRequest(prisma, {
        actorContext: auth.resumeState.actorContext,
        approvalActionType: policyDecision.approvalActionType,
        args: canonicalArgs,
        context,
        policyRuleId: policyDecision.policyRuleId,
        toolCallId,
        toolName,
        interactive: auth.resumeState.interactive,
        messageId: auth.resumeState.messageId,
        ...(boundaryReason ? { boundaryReason } : {}),
        ...(structuralContext ? { contextExtra: structuralContext } : {}),
        ...(structuralApprover ? { requiredApproverUserId: structuralApprover } : {}),
      })
      return {
        args: canonicalArgs,
        decision: 'suspend',
        approval: {
          id: approval.id,
          notice: `⚠️ I need approval: ${describeGatedAction(toolName, canonicalArgs).headline}.`,
          requiredApproverUserId: approval.requiredApproverUserId,
          toolName,
        },
      }
    }
    return {
      decision: 'deny',
      result: toolDeniedResult(toolName, canonicalArgs, {
        approvalActionType: policyDecision.approvalActionType,
        message: structuralState.denial?.message
          ?? (policyDecision.reason === 'approval_required'
            ? `Tool "${toolName}" requires approval before it can run.`
            : `Tool "${toolName}" was denied by policy.`),
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
      const review = await runAutoReview(
        hooks.reviewProposedAction,
        { args: canonicalArgs, surface, toolName },
      )
      await recordAutoReview(prisma, emitAudit, toolActorContext, context, toolName, surface, review)

      if (review.verdict === 'deny') {
        return {
          decision: 'deny',
          result: toolDeniedResult(toolName, canonicalArgs, {
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
            args: canonicalArgs,
            context,
            interactive: auth.resumeState.interactive,
            messageId: auth.resumeState.messageId,
            policyRuleId: policyDecision.policyRuleId,
            reason: notice,
            toolCallId,
            toolName,
          })
          return {
            args: canonicalArgs,
            decision: 'suspend',
            approval: {
              id: approval.id,
              notice,
              requiredApproverUserId: approval.requiredApproverUserId,
              toolName,
            },
          }
        }
        return {
          decision: 'deny',
          result: toolDeniedResult(toolName, canonicalArgs, {
            message: notice,
            policyRuleId: policyDecision.policyRuleId,
            policySource: policyDecision.policySource,
            reason: 'approval_required',
          }),
        }
      }
    }
  }

  // A structurally gated call has no PolicyRule to set approvalProofUsed. The
  // proof was nevertheless verified against its approval id, canonical args,
  // org, tool and direct continuation lineage above. Claim it here, after the
  // final pre-dispatch gate, so a stale or raced proof cannot bypass a
  // code-declared approval a second time.
  if (
    auth.consumeApprovalProof !== false
    && (policyDecision.approvalProofUsed || structuralApprovalProofUsed)
  ) {
    if (!await claimVerifiedToolApprovalProof({
      actorContext: toolActorContext,
      approval: toolActorContext.approval,
      args: canonicalArgs,
      context,
      emitAudit,
      prisma,
      toolName,
      verifiedApproval: policyDecision.approvalProofVerified ?? null,
    })) {
      await auditToolAuthorizationDenial(emitAudit, toolActorContext, context, toolName, {
        source: 'worker_tool_policy',
      }, 'approval_required')
      return {
        decision: 'deny',
        result: toolDeniedResult(toolName, canonicalArgs, {
          message: `Tool "${toolName}" requires approval before it can run.`,
          reason: 'approval_required',
        }),
      }
    }
  }

  return { args: canonicalArgs, decision: 'allow', toolActorContext }
}
