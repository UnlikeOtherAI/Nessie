import { z } from 'zod'

import { TimestampSchema } from './schema-primitives.js'

/**
 * Persistent recipient-private attention. Every kind is revalidated against
 * its linked resource before it is returned or counted.
 *
 * Lives here — not `api/src/contracts/alerts.ts` — because the admin (which
 * renders every alert kind, including `call_missed`'s click-through) has no
 * import path into `api/src`; the API contract file re-exports this schema
 * so route handlers keep one import surface (docs/architecture.md, "shared
 * runtime schemas").
 */
export const UserAlertKindSchema = z.enum([
  'mention',
  'task_assigned',
  'knowledge_published',
  // A scheduled trigger became non-runnable. Durable rather than push-only: the
  // failure this surfaces was previously invisible unless somebody opened the
  // Triggers page and read a delivery row.
  'trigger_health',
  'approval_requested',
  'call_missed',
  'team_invitation',
  // An automatic-membership rule's authorization stopped verifying, so nobody
  // new is being added to its team. Durable for the same reason as
  // trigger_health: otherwise it is visible only to whoever happens to open the
  // Automatic logins tab.
  'automatic_membership_health',
  // A project board's external source stopped syncing. Durable for the same
  // reason as the two above: a board that has quietly stopped updating still
  // looks exactly like a board.
  'board_source_health',
  // A ticket moved or changed on a board this person watches. Durable because
  // somebody explicitly asked to be told: a push is missable, the bell is not.
  'board_ticket_changed',
  // A workflow run entered its terminal failed state. The linked run is the
  // recovery doorway, and visibility is rechecked on every bell read.
  'workflow_run_failed',
  // Somebody shared one of their own documents with this person. Reader side
  // only for now: the value is parseable one deploy before anything writes it,
  // because a realtime payload carrying a kind an older replica cannot parse
  // crashes that replica during a blue-green swap.
  'knowledge_shared',
  // Reader-first for a custodian-private local host repair. The writer is
  // deliberately separate from this parse contract so a rolling deploy never
  // sends an unparseable realtime alert to an older replica.
  'local_inference_health',
  'task_set_health',
  // An agent set up a ticket trigger for this person, and its machine access
  // is still the machines' owner's to set up. Written in the deploy that adds
  // it: nothing pushes or streams it, so no older replica is handed one.
  'trigger_machine_access',
  // A budget crossed its warn threshold, or first stopped work, this period.
  // It used to be a push alone, so an owner without a registered device never
  // heard; now it is a bell row too, once per budget, period and kind, exactly
  // as the push was. Written in the deploy that adds it for the reason above:
  // no realtime frame carries it, only the owner's next bell read.
  'budget_alert',
])
export type UserAlertKind = z.infer<typeof UserAlertKindSchema>

/**
 * What a `budget_alert` row says: which budget, what happened, how far along.
 * Read from the once-per-period marker the row points at; the scope's name is
 * read when the bell is, so a renamed team reads by its new name.
 */
export const BudgetAlertSummarySchema = z.object({
  /** `threshold`: spend reached the warn level; `blocked`: the budget stopped work. */
  kind: z.enum(['threshold', 'blocked']),
  scopeType: z.enum(['organization', 'team', 'project']),
  /** Null when the scope no longer exists in this organisation. */
  scopeName: z.string().nullable(),
  percentUsed: z.number().int().nullable(),
  period: z.enum(['weekly', 'monthly', 'yearly']),
})
export type BudgetAlertSummary = z.infer<typeof BudgetAlertSummarySchema>

export const TeamInvitationAlertMetadataSchema = z.object({
  inviteId: z.string().min(1),
  // The invitation's OWN organisation, which is not necessarily the alert
  // row's `organizationId` — that one is the bell this row appears in. A
  // cross-organisation invitation is filed in the bell the recipient is
  // looking at (they have no membership in the inviting organisation yet, so a
  // row filed there would be invisible), and these two fields are what let the
  // row still name where the invitation came from.
  organizationId: z.string().min(1),
  teamId: z.string().min(1),
  teamName: z.string().min(1),
  orgName: z.string().min(1).optional(),
  invitedBy: z.string().min(1).optional(),
  expiresAt: TimestampSchema.optional(),
}).strict()
export type TeamInvitationAlertMetadata = z.infer<
  typeof TeamInvitationAlertMetadataSchema
>

export const UserAlertRecordSchema = z.object({
  id: z.string().uuid(),
  kind: UserAlertKindSchema,
  messageId: z.string().uuid().nullable(),
  rootMessageId: z.string().uuid().nullable(),
  threadId: z.string().uuid().nullable(),
  channelId: z.string().uuid().nullable(),
  channelLabel: z.string().nullable(),
  projectId: z.string().uuid().nullable(),
  taskId: z.string().uuid().nullable(),
  taskSetId: z.string().uuid().nullable().optional(),
  knowledgePageId: z.string().uuid().nullable(),
  triggerId: z.string().uuid().nullable(),
  // The trigger's own name, for the one kind whose line names it
  // ("<trigger> needs machine access: …"). Optional: older rows and every
  // other kind carry none.
  triggerName: z.string().nullable().optional(),
  // An automatic-membership health alert is actionable only when the bell can
  // name the exact rule that failed. The optional shape preserves old rows
  // created before this relationship was projected through the alert API.
  automaticMembershipRuleId: z.string().uuid().nullable().optional(),
  automaticMembershipRuleTeamName: z.string().min(1).nullable().optional(),
  boardSourceId: z.string().uuid().nullable(),
  workflowRunId: z.string().uuid().nullable(),
  callId: z.string().uuid().nullable(),
  // Reader-first for the local host health writer. These stay optional while
  // older API replicas and persisted alert fixtures are still being drained;
  // a writer must always set the host id so visibility is custodian-bound.
  localInferenceHostId: z.string().uuid().nullable().optional(),
  localInferenceBindingId: z.string().uuid().nullable().optional(),
  // Present only on a `budget_alert` row. Optional so a replica of the
  // previous build, which never sets it, still parses every row it sends.
  budgetAlert: BudgetAlertSummarySchema.nullable().optional(),
  metadata: TeamInvitationAlertMetadataSchema.nullable(),
  actorUserId: z.string().uuid().nullable(),
  actorAgentId: z.string().uuid().nullable(),
  actorDisplayName: z.string().nullable(),
  readAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
})
export type UserAlertRecord = z.infer<typeof UserAlertRecordSchema>
