import { z } from 'zod'

import {
  AuditLogIdSchema,
  ChannelIdSchema,
  OrganizationIdSchema,
  PolicyBindingIdSchema,
  PolicyIdSchema,
  ProjectIdSchema,
  TeamIdSchema,
} from './ids.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

// ─── Phase 2: Policy Enforcement ────────────────────────────────────────────

export const PolicyScopeSchema = z.enum([
  'organization',
  'project',
  'team',
  'channel',
  'agent',
  'tool',
  'user',
])
export type PolicyScope = z.infer<typeof PolicyScopeSchema>

export const PolicyResourceTypeSchema = z.enum([
  'agent',
  'channel',
  'project',
  'tool',
  'session',
  'task',
  'review',
  'approval',
  'admin',
  'secret',
  'knowledge_space',
  'knowledge_page',
])
export type PolicyResourceType = z.infer<typeof PolicyResourceTypeSchema>

export const PolicyActionSchema = z.enum([
  'view',
  'invoke',
  'create',
  'edit',
  'assign',
  'approve',
  'review',
  'search',
  'export',
  'admin',
  'resolve',
  'rotate',
  'revoke',
  'bind',
  'link',
  'reindex',
  'summarize',
  'read',
  'import',
  'grant',
  'enroll',
  'challenge',
])
export type PolicyAction = z.infer<typeof PolicyActionSchema>

export const PolicyEffectSchema = z.enum(['allow', 'deny'])
export type PolicyEffect = z.infer<typeof PolicyEffectSchema>

export const PolicyConditionsSchema = z.object({
  timeWindow: z
    .object({
      startHour: z.number().int().min(0).max(23),
      endHour: z.number().int().min(0).max(23),
      daysOfWeek: z.array(z.number().int().min(0).max(6)),
    })
    .optional(),
  ipRanges: z.array(z.string()).optional(),
  requiresApproval: z.boolean().optional(),
  approvalActionType: z.string().optional(),
  reviewMode: z.enum(['auto']).optional(),
  maxUsagePerHour: z.number().int().positive().optional(),
})
export type PolicyConditions = z.infer<typeof PolicyConditionsSchema>

export const PolicyDecisionSchema = z.object({
  allowed: z.boolean(),
  policyRuleId: z.string().optional(),
  policySource: z.string(),
  reasonCode: z.enum([
    'EXPLICIT_DENY',
    'NO_MATCHING_ALLOW',
    'CHANNEL_MEMBERSHIP_REQUIRED',
    'APPROVAL_REQUIRED',
    'CONDITIONS_NOT_MET',
    'SCOPE_NOT_AVAILABLE',
    'ALLOWED',
  ]),
  requiresApproval: z.boolean().optional(),
  approvalActionType: z.string().optional(),
  reviewMode: z.enum(['auto']).optional(),
  /** Internal worker signal: a verified proof satisfied this decision. */
  approvalProofUsed: z.boolean().optional(),
})
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>

export const PolicyRuleResponseSchema = z.object({
  id: PolicyIdSchema,
  organizationId: OrganizationIdSchema,
  scope: PolicyScopeSchema,
  scopeId: NonEmptyStringSchema,
  resourceType: PolicyResourceTypeSchema,
  action: PolicyActionSchema,
  effect: PolicyEffectSchema,
  priority: z.number().int(),
  conditions: PolicyConditionsSchema.nullable(),
  createdBy: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  bindings: z.array(
    z.object({
      id: PolicyBindingIdSchema,
      actorType: z.enum(['user', 'agent', 'service', 'role']),
      actorId: NonEmptyStringSchema,
    }),
  ),
})
export type PolicyRuleResponse = z.infer<typeof PolicyRuleResponseSchema>

export const EffectivePolicySchema = z.object({
  decisions: z.array(
    z.object({
      resourceType: PolicyResourceTypeSchema,
      action: PolicyActionSchema,
      decision: PolicyDecisionSchema,
    }),
  ),
})
export type EffectivePolicy = z.infer<typeof EffectivePolicySchema>

// ─── Phase 2: Approval Gating ──────────────────────────────────────────────
//
// The approval-gate record and its resolve-body schema live in
// `approval-records.ts` (`ApprovalRequestRecordSchema`,
// `ResolveApprovalBodySchema`) — the ones `api/src/services/approvals.ts`
// actually produces and `api/src/routes/approvals.ts` parses against. This
// file previously carried a second, never-wired copy that used `.optional()`
// where the real mapper returns `null`, so it could not have validated a
// real response; removed rather than kept as a second definition of the same
// concept.

// ─── Phase 2: Audit Trail ──────────────────────────────────────────────────

export const AuditActionSchema = z.enum([
  'app.connected',
  'app.capabilities_refreshed',
  'app.disconnected',
  'auth.bootstrap',
  'auth.login',
  'auth.logout',
  'auth.login_failed',
  'auth.rate_limit.lockout',
  'user.created',
  'user.updated',
  'user.deleted',
  'user.role_changed',
  'organization.updated',

  // Automatic team access after sign-in, by DNS-verified email domain
  // (docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md).
  // The challenge is never carried in the metadata of any of these.
  'organization.automatic_membership.domain_created',
  'organization.automatic_membership.dns_checked',
  'organization.automatic_membership.domain_verified',
  'organization.automatic_membership.domain_activated',
  'organization.automatic_membership.domain_suspended',
  'organization.automatic_membership.domain_revoked',
  'organization.automatic_membership.challenge_rotated',
  'organization.automatic_membership.rule_changed',
  'organization.automatic_membership.rule_reauthorized',
  'organization.automatic_membership.rule_needs_reauthorization',
  'organization.automatic_membership.grant_issued',
  'organization.automatic_membership.provisioning_toggled',
  'organization.automatic_membership.reconcile_started',
  'organization.automatic_membership.reconcile_finished',
  'organization.automatic_membership.reconcile_cancelled',
  // A membership invitation, whether it admits someone into the organisation
  // roster directly or through one of its teams. The action is shared across
  // both routers (`routes/organization-members.ts`, `routes/team-members.ts`);
  // `resourceType` ('organization_invitation' vs 'team_invitation') and the
  // `scope` metadata field carry which one. Never carries the invitee's email.
  'organization.member_invited',
  'organization.member_invitation_revoked',
  'organization.member_invitation_reviewed',
  'project.created',
  'project.updated',
  'project.deleted',
  'project.member_added',
  'project.member_removed',
  'team.created',
  'team.updated',
  'team.deleted',
  'team.member_added',
  'team.member_removed',
  'channel.created',
  'channel.updated',
  'channel.deleted',
  'channel.member_added',
  'channel.member_removed',
  'channel.visibility_changed',
  'agent.created',
  'agent.owner_changed',
  'agent.updated',
  'agent.retired',
  'agent.restored',
  'agent.deleted',
  'agent.bound',
  'agent.unbound',
  'agent.todo_template.published',
  // Agent triggers: arming an automation decides what runs unattended, on
  // whose identity and how often, so its full lifecycle is audited.
  'trigger.created',
  'trigger.updated',
  'trigger.deleted',
  'trigger.fired',
  'trigger.reauthorized',
  'trigger.paused',
  'trigger.resumed',
  'demonstration.started',
  'demonstration.stopped',
  'demonstration.generalized',
  'workflow.template.adopted',
  'agent.private.paused_owner_deactivated',
  'personal_assistant.bootstrap',
  'personal_assistant.rotate',
  'personal_assistant.suspend',
  'personal_assistant.reactivate',
  'personal_assistant.access_denied',
  'tool.granted',
  'tool.revoked',
  // A human-in-the-loop card (a secret request, a todo confirmation, …)
  // being answered. `resourceId` is the card id; the values a person typed
  // never enter the metadata even through redaction.
  'agent_card.responded',
  // Personal secret vault (org/team/project/personal scoped secrets stored
  // in the external Infisical vault). Reference and scope only — never the
  // plaintext value.
  'secret.created',
  'secret.rotated',
  'secret.revoked',
  'secret.access_granted',
  // A message whose body was overwritten after a secret typed into it was
  // captured out to the vault — the plaintext must not linger in the
  // channel history or in message memory recall.
  'message.redacted',
  // A scoped setting write (org/team/project/personal). Value shape is
  // setting-specific, so the audit metadata carries the key and scope, not
  // a fixed schema.
  'setting.scoped.written',
  // MCP connector instances and the credentials bound to them. The
  // credential reference is audited, never the secret material itself.
  'mcp.instance.created',
  'mcp.instance.deleted',
  'mcp.credential.written',
  'mcp.credential.deleted',
  'executor.access_change.prepared',
  'executor.access_change.confirmed',
  'executor.access_change.rejected',
  'executor.access_change.expired',
  'executor.workspace_promotion.prepared',
  'executor.workspace_promotion.confirmed',
  'executor.workspace_promotion.rejected',
  'executor.run.launched',
  'executor.browser.action.dispatched',
  'executor.command.run.dispatched',
  'approval.created',
  'approval.approved',
  'approval.rejected',
  'approval.expired',
  'pricing.created',
  'pricing.updated',
  'pricing.deleted',
  'policy.created',
  'policy.updated',
  'policy.deleted',
  'policy.evaluated',
  'kb.space.created',
  'kb.space.updated',
  'kb.space.archived',
  'kb.page.created',
  'kb.page.updated',
  'kb.page.published',
  'kb.page.moved',
  'kb.page.restored',
  'kb.page.archived',
  'kb.librarian.ensured',
  'kb.search.summarized',
  'kb.annotation.created',
  'kb.annotation.replied',
  'kb.annotation.resolved',
  'kb.annotation.reopened',
  'kb.annotation.updated',
  'kb.annotation.deleted',
  'push.credential.uploaded',
  'push.credential.deleted',
  'push.credential.tested',
  'workflow.template.created',
  'workflow.template.updated',
  'workflow.installation.installed',
  'workflow.installation.updated',
  'workflow.run.started',
  'workflow.run.cancelled',
  'workflow.run.retried',
  'workflow.step_run.skipped',
  'workflow.step_run.blocked',
  'workflow.step_run.unblocked',
  'comms.connection.created',
  'comms.connection.disconnected',
  'comms.connection.data_deleted',
  'comms.connection.capabilities_changed',
  // Hosted agent mailboxes. Every outbound send is audited (with the approval
  // id when one gated it), as is every mailbox lifecycle change and every
  // bounce/complaint the deployment's SES account reports back.
  'email.mailbox.created',
  'email.mailbox.updated',
  'email.mailbox.deleted',
  'email.sent',
  'email.send_failed',
  'email.received',
  'email.bounced',
  'email.complained',
  'email.domain.created',
  'email.domain.verified',
  'email.domain.revoked',
  // Personal model subscriptions. Metadata only — a link's credential and its
  // vault location never enter the audit trail.
  'model_subscription.linked',
  'model_subscription.relinked',
  'model_subscription.disconnected',
  // Gmail is a state machine: a held draft is not delivered, and a provider
  // timeout is not evidence that delivery failed. Keep every transition
  // explicit and content-free in the audit chain.
  'gmail.draft.held',
  'gmail.draft.undone',
  'gmail.draft.sent',
  'gmail.draft.delivery_unknown',
  'gmail.send_grant.created',
  'gmail.send_grant.revoked',
  // Connected SMTP/IMAP mailboxes (agent email Model A). The address and the
  // scope are recorded; the username and password never are.
  'mailbox.connection.created',
  'mailbox.connection.deleted',
  'mailbox.access.granted',
  'mailbox.access.revoked',
])
export type AuditAction = z.infer<typeof AuditActionSchema>

export const AuditOutcomeSchema = z.enum(['success', 'denied', 'error'])
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>

export const AuditActorTypeSchema = z.enum(['user', 'agent', 'service', 'system'])
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>

export const AuditLogResponseSchema = z.object({
  id: AuditLogIdSchema,
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema.optional(),
  teamId: TeamIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  actorType: AuditActorTypeSchema,
  actorId: NonEmptyStringSchema,
  action: AuditActionSchema,
  resourceType: NonEmptyStringSchema,
  resourceId: NonEmptyStringSchema.optional(),
  outcome: AuditOutcomeSchema,
  reason: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  requestId: NonEmptyStringSchema,
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
  createdAt: TimestampSchema,
})
export type AuditLogResponse = z.infer<typeof AuditLogResponseSchema>

export const AuditLogSummarySchema = z.object({
  groupBy: NonEmptyStringSchema,
  entries: z.array(
    z.object({
      key: NonEmptyStringSchema,
      count: z.number().int().nonnegative(),
    }),
  ),
})
export type AuditLogSummary = z.infer<typeof AuditLogSummarySchema>
