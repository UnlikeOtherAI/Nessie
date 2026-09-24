-- A ticket's work that leaves a machine for another — it stayed offline past
-- its trigger's waitingMachineHours, or was placed elsewhere — closes the
-- sessions it leaves there when that machine next reports; queued work
-- cancelled because the person whose move started it can no longer edit the
-- board closes its sessions too
-- (docs/plans/2026-09-23-ticket-driven-agents/ticket-work.md → "The pool
-- queue"). Each for a reason of its own. Widen the close-request CHECK to
-- EXECUTOR_CODING_SESSION_CLOSE_REASONS in @nessie/schemas, which gained
-- `machine_reassigned` and `mover_lost_access`. Additive: every row the
-- previous release wrote still passes, and it writes neither new reason.
ALTER TABLE "executor_coding_session_close_requests"
  DROP CONSTRAINT "executor_coding_session_close_requests_reason_known",
  ADD CONSTRAINT "executor_coding_session_close_requests_reason_known"
    CHECK ("reason" IN (
      'lease_ended', 'access_revoked', 'executor_paused', 'executor_revoked', 'person',
      'ticket_left_flow', 'trigger_changed', 'policy_suspended', 'policy_ended', 'work_limit',
      'machine_reassigned', 'mover_lost_access'
    ));
