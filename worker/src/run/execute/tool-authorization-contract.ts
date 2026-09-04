import type { AuthorizedActionContext } from '@nessie/schemas'
import type { JudgedGmailDraftAuthorization } from '@nessie/team-admin'

import type { GmailJudgedProjection } from './gmail-judged-projection.js'

import type { AutoReviewResult, ReviewableToolSurface } from './auto-review.js'
import type { DeepWaterHandoffGuard } from '../deepwater-handoff-guard.js'
import type { AgenticToolResult } from '../tools.js'
import type { ToolApprovalAuditEmitter } from './tool-approval.js'
import type { StructuralGate } from './structural-gates.js'
import type { RunContext } from './types.js'

export type ToolActorContext = AuthorizedActionContext

export type ToolAuthorizationDecision =
  | {
      args: Record<string, unknown>
      decision: 'allow'
      /**
       * Set only after the dispatcher verified this exact approval against the
       * canonical action and won its atomic proof claim. It is deliberately a
       * content-free capability fact, never the opaque proof itself.
       */
      approvalProofClaimedForTool?: string
      /** Server-minted judged-grant fact; never reconstructed from tool input. */
      judgedGmailDraftAuthorization?: JudgedGmailDraftAuthorization
      toolActorContext: ToolActorContext
    }
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
  /** Recheck a structural mail boundary before consuming a sealed action. */
  revalidateApprovalBoundary?: boolean
  /** A prepared call has already received its single auto-review verdict. */
  skipAutoReview?: boolean
  resumeState?: { actorContext: AuthorizedActionContext; interactive: boolean; messageId: string }
  /** A structurally gated family whose outcome is authoritative. */
  structuralGate?: StructuralGate
  /** Exact Gmail correspondence for one silent, non-durable boundary decision. */
  loadGmailJudgedProjection?: (input: {
    connectionId: string
    draftActionId: string
    expectedFingerprint: string
    requestingUserId: string
  }) => Promise<GmailJudgedProjection | null>
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
