-- One ticket's work under a standing policy closes its own coding sessions
-- (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "Server-side
-- closes"), for five reasons of its own. Widen the close-request CHECK to
-- EXECUTOR_CODING_SESSION_CLOSE_REASONS in @nessie/schemas, which gained
-- them. Additive: every row the previous release wrote still passes, and it
-- writes none of the new reasons.
ALTER TABLE "executor_coding_session_close_requests"
  DROP CONSTRAINT "executor_coding_session_close_requests_reason_known",
  ADD CONSTRAINT "executor_coding_session_close_requests_reason_known"
    CHECK ("reason" IN (
      'lease_ended', 'access_revoked', 'executor_paused', 'executor_revoked', 'person',
      'ticket_left_flow', 'trigger_changed', 'policy_suspended', 'policy_ended', 'work_limit'
    ));
