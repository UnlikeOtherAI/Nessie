-- Standing machine access after review
-- (docs/standards/ticket-work-machine-access.md). Additive: the CHECK only
-- widens, and the new column has a default no earlier writer depends on.

-- A policy pins its agent's definition too (its instructions, model, tool
-- policy and connectors); an edit of any of it suspends the policy until the
-- author confirms it again.
ALTER TABLE "executor_standing_policies" DROP CONSTRAINT "executor_standing_policies_suspended_reason_known";
ALTER TABLE "executor_standing_policies" ADD CONSTRAINT "executor_standing_policies_suspended_reason_known"
  CHECK (
    ("status" <> 'suspended' AND "suspended_reason" IS NULL)
    OR (
      "status" = 'suspended'
      AND "suspended_reason" IS NOT NULL
      AND "suspended_reason" IN ('trigger_changed', 'descriptor_changed', 'agent_changed')
    )
  );

-- Where and when each of a record's coding sessions was started
-- (`"<sessionId>": {"executorId": …, "policyId": …, "startedAt": …}`): a
-- session is closed on its own machine under its own policy's owner context,
-- whichever machine the record holds now, and a session recorded after the
-- machine's last report counts as live until a later report says otherwise.
ALTER TABLE "agent_ticket_work" ADD COLUMN "session_origins" JSONB NOT NULL DEFAULT '{}';
