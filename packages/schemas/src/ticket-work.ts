import { z } from 'zod'

/**
 * The closed vocabularies of ticket work, standing machine access and agent
 * reminders (docs/plans/2026-09-23-ticket-driven-agents).
 *
 * Each list is also a CHECK constraint in
 * `api/prisma/migrations/20260923220000_ticket_work_contracts`, and
 * `api/test/ticket-work-contracts-migration.test.ts` reads that SQL and fails
 * when the two disagree. Adding a value is therefore two edits in one change:
 * the list here, and a migration that drops and re-adds the CHECK.
 */

/**
 * Where one ticket's work stands. `queued`, `active`, `parked` and
 * `waiting_machine` are live; at most one live record exists per
 * (trigger, ticket), and at most one `active` record per machine.
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
])
export type TicketWorkStateReason = z.infer<typeof TicketWorkStateReasonSchema>

/**
 * Why a ticket's agent was woken: the first block of every `ticket.work`
 * kickoff. These are configuration vocabulary the trigger's instructions are
 * sectioned by, not behaviour the platform attaches to them.
 */
export const TicketWorkWakeReasonSchema = z.enum([
  'pickup',
  'dequeued',
  'queued',
  'ticket_commented',
  'ticket_description_changed',
  'ticket_priority_changed',
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

/**
 * A standing machine-access policy's lifecycle. `preparing` has a card out and
 * binds nothing; `live` binds; `suspended` binds nothing until the author
 * re-confirms; `ended` is final.
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
  // The project, the board or a pickup column was archived.
  'scope_archived',
  'trigger_deleted',
  // A prepared card was never confirmed.
  'expired',
  // A new prepare (a changed pool or a raised limit) took its place.
  'replaced',
])
export type ExecutorStandingPolicyEndedReason = z.infer<
  typeof ExecutorStandingPolicyEndedReasonSchema
>

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
