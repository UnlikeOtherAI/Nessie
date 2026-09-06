/**
 * Team administration shared by the API routes and the worker.
 *
 * Creating a channel, creating an agent, binding an agent to a channel, and
 * arming a trigger are things a person does by clicking and the personal
 * assistant does by being asked. Both must be the same operation — same
 * validation, same tenancy checks, same protected-key refusals — so the service
 * functions live here and `api/src/services/*` re-exports them.
 */
export * from './access-checks.js'
export * from './agent-avatar-generation.js'
export * from './agent-bindings.js'
export * from './agent-create.js'
export * from './agent-edit-authority.js'
export * from './agent-list.js'
export * from './agent-model-order.js'
export * from './agent-model-options.js'
export * from './agent-model-selection.js'
export * from './agent-read.js'
export * from './agent-record.js'
export * from './agent-tool-catalog.js'
export * from './agent-update.js'
export * from './agent-card-presentation.js'
export * from './agent-card-values.js'
export * from './agent-todo-errors.js'
export * from './agent-todo-instances.js'
export * from './agent-todo-kickoff.js'
export * from './agent-todo-lock.js'
export * from './agent-todo-lock.js'
export * from './agent-todo-prompt-facts.js'
export * from './agent-todo-records.js'
export * from './agent-todo-realtime.js'
export * from './agent-todo-run.js'
export * from './agent-todo-run-statuses.js'
export * from './agent-todo-schedule.js'
export * from './agent-todo-steps.js'
export * from './agent-todo-templates.js'
export * from './demonstrations.js'
export * from './agent-tool-policy-core.js'
export * from './global-agent-blueprints.js'
export * from './global-agent-bootstrap.js'
export * from './global-agent-brief.js'
export * from './global-agent-catalogue.js'
export * from './channel-create.js'
export * from './channel-manage.js'
export * from './channel-records.js'
export * from './channel-slugs.js'
export * from './call-links.js'
export * from './call-action-token.js'
export * from './call-push-jobs.js'
export * from './call-realtime.js'
export * from './call-start.js'
export * from './comms-connection-management.js'
export * from './comms-credential-coordinator.js'
export * from './connected-mail.js'
export * from './mailbox-send-actions.js'
export * from './ledger-agent-model-catalog.js'
export * from './policy-check.js'
export * from './board-structure.js'
export * from './task-fields.js'
export * from './board-source-apply.js'
export * from './board-source-identity.js'
export * from './board-source-structure.js'
export * from './board-source-writeback.js'
export * from './board-source-credential.js'
export * from './board-placement.js'
export * from './project-administration.js'
export * from './project-structure.js'
export * from './project-task-move.js'
export * from './project-task-attention.js'
export * from './project-task-records.js'
export * from './project-task-status.js'
export * from './project-tasks.js'
export * from './private-agent-home.js'
export * from './personal-assistant-presence.js'
export * from './trigger-config-identity.js'
export * from './trigger-core.js'
export * from './trigger-create.js'
export * from './trigger-launch-origin.js'
export * from './roster-local-identity.js'
export * from './uoa-org-profile.js'
export * from './uoa-org-provisioning.js'
export * from './uoa-org-roster.js'
export * from './uoa-org-roster-pages.js'
export { createTeamInvitations } from './uoa-org-roster-invitations.js'
export * from './uoa-org-members.js'
export * from './automatic-membership-dns.js'
export * from './automatic-membership-grant.js'
export * from './automatic-membership-rules.js'
export * from './uoa-role-capabilities.js'
export * from './uoa-settings.js'
export * from './workflow-binding-grammar.js'
export * from './workflow-authoring.js'
export * from './workflow-audit.js'
export * from './workflow-access.js'
export * from './workflow-graph-pin.js'
export * from './workflow-run-references.js'
export * from './workflow-run-start.js'
export * from './workflow-secrets.js'
export * from './sandboxed-jmespath.js'
export * from './workflow-jmespath.js'
export * from './workflow-template-validation.js'
export * from './workflow-template-list.js'
export * from './workflow-template-update.js'
export * from './workflow-trigger-create.js'
export * from "./workflow-concurrency.js"
export {
  AgentMailboxError,
  assertMailboxEligible,
  createAgentMailbox,
  loadAgentMailbox,
  resolveMailboxByAddress,
  retireAgentMailbox,
  updateAgentMailbox,
  type CreateMailboxInput,
  type MailboxAgent,
  type MailboxRecord,
  type MailboxRefusal,
  type UpdateMailboxInput,
} from './agent-mailbox.js'

export {
  GmailDraftError,
  composeDraftForUser,
  updateDraftForUser,
  readDraftForUser,
  sendDraftForUser,
  dispatchClaimedDraft,
  resolveStaleGmailDispatches,
  resolveStaleGmailDraftValidations,
  resolveStaleGmailDraftUpdates,
  undoHeldSend,
  discardDraftForUser,
  attachDraftMessage,
  fingerprintDraft,
  type GmailDraftActionRecord,
  type GmailDraftDeps,
  type GmailDraftErrorCode,
  type SendDraftResult,
} from './gmail-drafts.js'

export {
  SEND_GRANT_DURATIONS,
  expiryForSendGrant,
  hasStandingSendAuthorization,
  grantSendAuthorization,
  revokeSendAuthorization,
  listSendAuthorizations,
  resolveStandingConsentForToolCall,
  loadLiveSendGrant,
  recordSendDecision,
  type LiveSendGrant,
  type StandingConsentDecision,
  type SendGrantDuration,
  type SendGrantRecord,
} from './send-authorization.js'

export {
  MailboxConnectionError,
  createMailboxConnection,
  deleteMailboxConnection,
  isCredentialRejection,
  listMailboxConnectionsForUser,
  loadManageableMailboxConnection,
  mailboxConnectionTestFailure,
  presentMailboxConnection,
  setMailboxAgentAccess,
  verifyMailboxConnection,
  type ActingMember as MailboxActingMember,
  type CreateMailboxConnectionInput,
  type MailboxConnectionRefusal,
  type MailboxConnectionTestFailure,
} from './mailbox-connections.js'

export {
  MailboxCredentialMissingError,
  mailboxDialOptions,
  mailboxEndpointsFor,
  type MailboxConnectionRow,
} from './mailbox-connection-endpoints.js'

export {
  MailboxAccessError,
  listReachableMailboxes,
  markMailboxNeedsReauthorization,
  openMailboxEndpoints,
  resolveMailboxForToolCall,
  type MailboxAccessErrorCode,
  type ReachableMailbox,
} from './mailbox-connection-access.js'

export {
  ConnectedMailPresentationError,
  resolveConnectedMailPresentationAccess,
  type ConnectedMailPresentationAccess,
} from './connected-mail-presentation.js'
