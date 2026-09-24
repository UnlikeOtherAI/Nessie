-- A ticket's work whose machine stayed offline past its trigger's
-- waitingMachineHours is queued again for another machine of its pool
-- (docs/plans/2026-09-23-ticket-driven-agents/ticket-work.md → "The pool
-- queue"); the sessions it leaves on the offline machine are closed when that
-- machine reconnects, for a reason of their own. Widen the close-request CHECK
-- to EXECUTOR_CODING_SESSION_CLOSE_REASONS in @nessie/schemas, which gained
-- `machine_reassigned`. Additive: every row the previous release wrote still
-- passes, and it writes none of the new reason.
ALTER TABLE "executor_coding_session_close_requests"
  DROP CONSTRAINT "executor_coding_session_close_requests_reason_known",
  ADD CONSTRAINT "executor_coding_session_close_requests_reason_known"
    CHECK ("reason" IN (
      'lease_ended', 'access_revoked', 'executor_paused', 'executor_revoked', 'person',
      'ticket_left_flow', 'trigger_changed', 'policy_suspended', 'policy_ended', 'work_limit',
      'machine_reassigned'
    ));
