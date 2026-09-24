import { z } from 'zod'

/**
 * The run purpose and the closed vocabularies of ticket work, standing machine
 * access and agent reminders (docs/plans/2026-09-23-ticket-driven-agents).
 *
 * Each list is also a CHECK constraint (or a partial index's WHERE), first
 * written in `api/prisma/migrations/20260923220000_ticket_work_contracts`.
 * `api/test/ticket-work-contracts-migration.test.ts` reads every migration in
 * order and compares each list with the constraint's latest definition, and
 * `api/test/ticket-work-contracts-postgres.test.ts` compares it with the
 * migrated database. Adding a value is therefore two edits in one change: the
 * list here, and a new migration that drops and re-adds the CHECK.
 */

/**
 * The action purpose of every run a ticket's work record wakes. Such a run
 * acts as the agent with no effective user, and its kickoff is a hidden
 * `system` message rebuilt from the work record. A kickoff that pends behind a
 * busy thread therefore drains alone (`packages/db/src/thread-serialization.ts`):
 * folded into a batch it would lose its wake facts, and a person's message in
 * the same batch would be consumed under the agent's authority.
 */
export const TICKET_WORK_PURPOSE = 'ticket.work'

/**
 * Where one ticket's work stands. `queued`, `active`, `parked` and
 * `waiting_machine` are live; at most one live record exists per
 * (trigger, ticket), and at most one record holds each machine: the `active`
 * one, or the `waiting_machine` one waiting for that machine to reconnect.
 */
export const TicketWorkStatusSchema = z.enum([
  'queued',
  'active',
  'parked',
  'waiting_machine',
  'done',
  'cancelled',
  'failed',
])
export type TicketWorkStatus = z.infer<typeof TicketWorkStatusSchema>

/** The live statuses: the partial unique index's WHERE list. */
export const TICKET_WORK_LIVE_STATUSES = [
  'queued',
  'active',
  'parked',
  'waiting_machine',
] as const satisfies readonly TicketWorkStatus[]

/** The terminal statuses: a record in one carries `endedAt` and `endedReason`. */
export const TICKET_WORK_TERMINAL_STATUSES = [
  'done',
  'cancelled',
  'failed',
] as const satisfies readonly TicketWorkStatus[]

/**
 * The statuses that hold the record's pinned machine: the unique index
 * `agent_ticket_work_one_per_executor`'s WHERE list. A `waiting_machine`
 * record waiting for its pinned machine to reconnect keeps its slot, so a
 * queued ticket is never assigned to that machine first. One waiting for
 * machine access (suspended or not set up) names no executor, so it holds
 * nothing. A `parked` or `queued` record may still name an executor without
 * holding it.
 */
export const TICKET_WORK_MACHINE_HOLDING_STATUSES = [
  'active',
  'waiting_machine',
] as const satisfies readonly TicketWorkStatus[]

/**
 * Why a work record is in its status, shown on the chip and in the wake facts.
 * A terminal record's `endedReason` is drawn from the same list: the reason it
 * ended is the reason it is in its final state.
 */
export const TicketWorkStateReasonSchema = z.enum([
  'queued_no_free_machine',
  'queued_machines_offline',
  'machine_access_not_set_up',
  'machine_access_suspended',
  'machine_access_ended',
  'machine_offline',
  'limit_wakes',
  'limit_hours',
  'limit_cost',
  'limit_daily',
  'left_flow',
  'merged',
  'mover_lost_access',
  'trigger_disabled',
  // The deployment's ledger refuses unsigned agent runs, and a `ticket.work`
  // run signs with no user identity, as event triggers do.
  'identity_unverifiable',
])
export type TicketWorkStateReason = z.infer<typeof TicketWorkStateReasonSchema>

/**
 * Why a ticket's agent was woken: the first block of every `ticket.work`
 * kickoff. These are configuration vocabulary the trigger's instructions are
 * sectioned by, not behaviour the platform attaches to them.
 *
 * One reason per `follow.kinds` entry: comment, description, priority, labels,
 * assignee, moved, thread_message and document. A `created` event straight
 * into a start-work column is a `pickup`.
 */
export const TicketWorkWakeReasonSchema = z.enum([
  'pickup',
  'dequeued',
  'queued',
  'ticket_commented',
  'ticket_description_changed',
  'ticket_priority_changed',
  'ticket_labels_changed',
  'ticket_assignee_changed',
  'ticket_moved',
  'thread_message',
  'document_changed',
  'session_turn_ended',
  'session_interrupted',
  'session_failed',
  'session_closed',
  'reminder',
  'quiet',
  'machine_back_online',
])
export type TicketWorkWakeReason = z.infer<typeof TicketWorkWakeReasonSchema>

/** A recorded pull request's state, exactly as `gh pr view --json state` spells it. */
export const TicketWorkPullRequestStateSchema = z.enum(['OPEN', 'CLOSED', 'MERGED'])
export type TicketWorkPullRequestState = z.infer<typeof TicketWorkPullRequestStateSchema>

/**
 * A standing machine-access policy's lifecycle. `preparing` has a card out and
 * binds nothing; `live` binds; `suspended` binds nothing until the author
 * re-confirms; `ended` is final. Per trigger, at most one policy is `live` or
 * `suspended` and at most one is `preparing` (partial unique indexes), so a
 * confirm ends the policy it replaces in the same transaction.
 */
export const ExecutorStandingPolicyStatusSchema = z.enum([
  'preparing',
  'live',
  'suspended',
  'ended',
])
export type ExecutorStandingPolicyStatus = z.infer<typeof ExecutorStandingPolicyStatusSchema>

/** Why a live policy stopped binding until its author re-confirms. */
export const ExecutorStandingPolicySuspendedReasonSchema = z.enum([
  // A trigger edit changed a field the policy pinned.
  'trigger_changed',
  // A descriptor review changed a pool machine's pinned digest.
  'descriptor_changed',
])
export type ExecutorStandingPolicySuspendedReason = z.infer<
  typeof ExecutorStandingPolicySuspendedReasonSchema
>

/**
 * Why a policy ended. The executor half matches the conversation-lease end
 * reasons, because the same fences end both; the rest are the fences only a
 * standing policy has.
 */
export const ExecutorStandingPolicyEndedReasonSchema = z.enum([
  // The author or an executor admin pressed End.
  'person',
  // The executor lost its private access to the author.
  'access_revoked',
  'executor_paused',
  'executor_drained',
  'executor_revoked',
  'descriptor_narrowed',
  // The author left the project or lost the right to edit the board.
  'author_lost_access',
  // uoa-roles deactivated the author.
  'author_deactivated',
  // The sweep found the author no longer listed by UOA.
  'author_left_organization',
  // The agent was unbound from the trigger's target channel.
  'agent_unbound',
  // The target channel was archived, made non-public or left the project: the
  // audience the author agreed to is no longer the one that reads the work.
  'target_channel_unavailable',
  // The project, the board or a pickup column was archived.
  'scope_archived',
  // Disabling the trigger ends its policy, as deleting it does: re-enabling
  // it takes a fresh confirmation.
  'trigger_disabled',
  'trigger_deleted',
  // A prepared card was never confirmed.
  'expired',
  // A new prepare (a changed pool or a raised limit) took its place.
  'replaced',
])
export type ExecutorStandingPolicyEndedReason = z.infer<
  typeof ExecutorStandingPolicyEndedReasonSchema
>

/**
 * Why the standing-policy binder bound no machine to one `ticket.work` run,
 * one per check it runs at every wake (docs/standards/ticket-work-machine-access.md
 * → "The machine owner's authority is read only by the standing-policy
 * binder"). Written on its audit row and its skipped delivery; not a CHECK.
 */
export const StandingPolicyBindRefusalReasonSchema = z.enum([
  'policy_not_live',
  'terms_changed',
  'author_unavailable',
  'machine_unavailable',
  'channel_unavailable',
  'not_this_work',
  'limit_reached',
])
export type StandingPolicyBindRefusalReason = z.infer<typeof StandingPolicyBindRefusalReasonSchema>

/** A `check_back_in` reminder's lifecycle. */
export const AgentReminderStatusSchema = z.enum(['pending', 'fired', 'cancelled'])
export type AgentReminderStatus = z.infer<typeof AgentReminderStatusSchema>

/** Why a pending reminder was cancelled instead of firing. */
export const AgentReminderCancelledReasonSchema = z.enum([
  // A new reminder for the same work record replaced it.
  'replaced',
  // Its work record ended.
  'work_ended',
  // A person pressed Cancel on the ticket's chip.
  'person',
])
export type AgentReminderCancelledReason = z.infer<typeof AgentReminderCancelledReasonSchema>
