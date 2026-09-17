import { z } from 'zod'

import { TimestampSchema } from './schema-primitives.js'

/**
 * What an approval is asking for, as a closed vocabulary.
 *
 * `action` used to be free text: the four effectful actions existed only as
 * bare string literals scattered across the worker and the API, and the
 * effect dispatcher (`api/src/services/approval-effects.ts`) switched on the
 * same strings, ending in a silent `default: return {}`. Nothing linked a
 * literal to the switch, so a typo produced the worst failure an approval
 * gate has: request filed, human approves, nothing happens — successfully,
 * with no error, and no way to tell a deliberately effect-free approval from
 * a misspelled one. Construction sites now draw from this object, and the
 * dispatch distinguishes the two sets below.
 */
export const APPROVAL_ACTIONS = {
  /** An agent-proposed to-do template wants activating. */
  agentTodoTemplatePublish: 'agent.todo_template.publish',
  /** An agent-authored knowledge draft wants publishing. */
  knowledgePagePublish: 'knowledge.page.publish',
  /** A run is suspended on a tool call a human must approve before it runs. */
  toolInvoke: 'tool.invoke',
  /** A learned (demonstration-generalised) workflow wants adopting. */
  workflowTemplateAdopt: 'workflow.template.adopt',
} as const
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[keyof typeof APPROVAL_ACTIONS]

/** The same vocabulary as a zod schema, for the card metadata below. */
export const APPROVAL_ACTION_VALUES = Object.values(APPROVAL_ACTIONS) as [
  ApprovalAction,
  ...ApprovalAction[],
]
export const ApprovalActionSchema = z.enum(APPROVAL_ACTION_VALUES)

/**
 * The subset whose approval *does* something once a human says yes — the
 * cases of the effect switch in `approval-effects.ts`.
 *
 * Every member of `APPROVAL_ACTIONS` belongs to exactly one of this set and
 * `EFFECT_FREE_APPROVAL_ACTIONS`; adding an action means choosing which, and
 * the schemas test for this file pins the partition so the two cannot drift.
 */
export const APPROVAL_EFFECT_ACTIONS: readonly ApprovalAction[] = [
  APPROVAL_ACTIONS.agentTodoTemplatePublish,
  APPROVAL_ACTIONS.knowledgePagePublish,
  APPROVAL_ACTIONS.toolInvoke,
  APPROVAL_ACTIONS.workflowTemplateAdopt,
]

/**
 * The subset whose approval is deliberately the whole effect: a human saying
 * yes IS the outcome and there is no follow-up mutation to dispatch. Empty
 * today — an action lands here when a gate is added that needs only the
 * decision. Membership is what excuses an action from the effect switch;
 * anything in neither set is unrecognised and fails loudly there.
 */
export const EFFECT_FREE_APPROVAL_ACTIONS: readonly ApprovalAction[] = []

/**
 * An approval-gate request as the client sees it. Lives here — not
 * `api/src/contracts/approvals.ts` — because the admin (which renders the
 * approvals surface) has no import path into `api/src`; the API contract
 * file re-exports this schema so route handlers keep one import surface
 * (docs/architecture.md, "shared runtime schemas").
 *
 * Deliberately omits `continuationToken`: that field is a resume secret on
 * the Prisma row and must never reach the client. Its absence here is what
 * makes that guarantee enforceable rather than merely true by convention.
 */
export const ApprovalRequestRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  teamId: z.string().uuid().nullable(),
  channelId: z.string().uuid().nullable(),
  taskId: z.string().uuid().nullable(),
  runId: z.string().uuid().nullable(),
  /// Null exactly when `agentAccessCredentialId` is set: a request opened
  /// through the MCP endpoint has no `Agent` row behind it.
  agentId: z.string().uuid().nullable(),
  agentAccessCredentialId: z.string().uuid().nullable(),
  requesterId: z.string().uuid(),
  // A persisted row outlives the vocabulary above: an approval written before
  // an action was retired must still render, so the read model stays lenient
  // while the write side (`CreateApprovalInput`, the gate metadata below) is
  // closed.
  action: z.string(),
  reason: z.string(),
  context: z.record(z.string(), z.unknown()).nullable(),
  status: z.string(),
  resolverId: z.string().uuid().nullable(),
  resolvedAt: TimestampSchema.nullable(),
  resolution: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  requiredApproverRole: z.string().nullable(),
  toolName: z.string().nullable(),
  expiresAt: TimestampSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ApprovalRequestRecord = z.infer<typeof ApprovalRequestRecordSchema>

export const ResolveApprovalBodySchema = z.object({
  resolution: z.enum(['approved', 'rejected']),
  note: z.string().max(2000).optional(),
}).strict()
export type ResolveApprovalBody = z.infer<typeof ResolveApprovalBodySchema>

/**
 * The card an approval is answered in.
 *
 * An approval lives in the conversation it came from and nowhere else: there
 * is no governance page to fall back to, so this metadata is the approval's
 * only doorway and every path that opens one writes it. It was previously
 * written inline by the run tool gate alone — the four other creators
 * (`knowledge.page.publish` from a PA tool and from the MCP endpoint,
 * `agent.todo_template.publish`, `workflow.template.adopt`) opened a request
 * with no card at all, which is what left them reachable only from the list
 * that no longer exists.
 *
 * `toolName`, `runId` and `checkpointId` are set only by the run gate, which
 * is the one kind that suspends a run and has a checkpoint to resume from.
 * `action` is always present and is what the card renders from.
 */
export const ApprovalGateMetadataSchema = z.object({
  action: ApprovalActionSchema,
  approvalId: z.string().min(1),
  checkpointId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  status: z.enum(['pending', 'approved', 'cancelled', 'expired', 'rejected']),
  toolName: z.string().min(1).optional(),
})
export type ApprovalGateMetadata = z.infer<typeof ApprovalGateMetadataSchema>

/**
 * Where an approval's card was posted, and why there.
 *
 * `origin` is the thread the run was already speaking in — which is also the
 * requester's thread for a delegated run, because a sub-agent run and a peer
 * delegation are both created on their parent's `threadId` rather than in a
 * conversation of their own. `assistant` is the approver's own Personal
 * Assistant conversation, used when there is no originating channel (a paired
 * MCP credential has none) or when the person who must answer cannot see the
 * one there is (an owner-gated proposal raised in a channel they are not in).
 */
export const ApprovalCardPlacementSchema = z.enum(['origin', 'assistant'])
export type ApprovalCardPlacement = z.infer<typeof ApprovalCardPlacementSchema>
