import type { AuthorizedActionContext } from '@nessie/schemas'

import type { AutoReviewResult, ReviewableToolSurface } from './auto-review.js'
import type { DeepWaterHandoffGuard } from '../deepwater-handoff-guard.js'
import type { AgenticToolResult } from '../tools.js'
import type { ToolApprovalAuditEmitter } from './tool-approval.js'
import type { RunContext } from './types.js'

export type ToolActorContext = AuthorizedActionContext

export type ToolAuthorizationDecision =
  | { args: Record<string, unknown>; decision: 'allow'; toolActorContext: ToolActorContext }
  | { decision: 'deny'; result: AgenticToolResult }
  | {
      args: Record<string, unknown>
      decision: 'suspend'
      approval: {
        id: string
        notice: string
        requiredApproverUserId: string | null
        toolName: string
      }
    }

export type ToolAuthorizationContext = {
  agentKind: RunContext['agent']['agentKind']
  allowedToolIds: Set<string>
  /** Resolved offer after capability gates such as todosEnabled. */
  resolvedBuiltinToolIds?: Set<string>
  /** Names dispatched outside the builtin registry. */
  externalToolNames?: Set<string>
  /** PA-only ids resolved at run setup, also checked against stale replays. */
  identityToolIds?: ReadonlySet<string>
  /** The main loop's live view, including deferred MCP names. */
  mcpToolNames?: ReadonlySet<string>
  /** The executor operations actually exposed for this run. */
  executorToolNames?: ReadonlySet<string>
  parentAgentId: string | null
  /** Only a top-level, non-handoff run has a durable identity to suspend. */
  maySuspendForApproval: boolean
  /** Fails closed to asking where no utility model resolves. */
  runUtility?: (prompt: string) => Promise<string | null>
  /** Preflight verifies a proof but leaves its one-time claim for dispatch. */
  consumeApprovalProof?: boolean
  /** A prepared call has already received its single auto-review verdict. */
  skipAutoReview?: boolean
  resumeState?: { actorContext: AuthorizedActionContext; interactive: boolean; messageId: string }
  /** A structurally gated family whose escalation decision is authoritative. */
  structuralGate?: (input: {
    toolName: string
    args: Record<string, unknown>
  }) => Promise<{
    escalate: boolean
    reason?: string
    requiredApproverUserId?: string | null
    /** Address-free server facts that an org owner may read on the approval. */
    contextExtra?: Record<string, unknown>
  } | null>
  toolPolicy: Record<string, boolean> | null
}

export type ToolAuthorizationAuditEmitter = ToolApprovalAuditEmitter

export type ToolAuthorizationHooks = {
  deepWaterHandoffGuard: DeepWaterHandoffGuard
  /** One bounded utility-model review, supplied by the caller that owns metering. */
  reviewProposedAction?: (input: {
    args: Record<string, unknown>
    surface: ReviewableToolSurface
    toolName: string
  }) => Promise<AutoReviewResult>
  /** Defaults to the policy audit emitter; a seam preserves delegate behaviour. */
  emitAudit?: ToolAuthorizationAuditEmitter
}
