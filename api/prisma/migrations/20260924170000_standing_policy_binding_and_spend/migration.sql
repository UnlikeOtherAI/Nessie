-- Standing machine access binds a ticket's work afresh at every wake
-- (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "Binding at
-- each wake", ticket-work.md → "Limits"; docs/standards/ticket-work-machine-access.md).
-- Additive: nothing the previous release wrote names a policy, and it writes
-- none of these columns or rows.

-- A binding made under a standing policy names the policy and the work record
-- it serves. The dispatch fence re-checks both on every command, and derives
-- the coding-session owner's context (`ticket:<policyId>:<taskId>`) from them,
-- never from anything the run sends. SET NULL: a binding whose policy or
-- record is gone reads as an ordinary binding, whose trigger message no person
-- wrote, and is fenced like one.
ALTER TABLE "executor_bindings"
  ADD COLUMN "standing_policy_id" UUID,
  ADD COLUMN "ticket_work_id" UUID;
CREATE INDEX "executor_bindings_standing_policy_id_idx" ON "executor_bindings"("standing_policy_id");
CREATE INDEX "executor_bindings_ticket_work_id_idx" ON "executor_bindings"("ticket_work_id");
ALTER TABLE "executor_bindings" ADD CONSTRAINT "executor_bindings_standing_policy_id_fkey"
  FOREIGN KEY ("standing_policy_id") REFERENCES "executor_standing_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "executor_bindings" ADD CONSTRAINT "executor_bindings_ticket_work_id_fkey"
  FOREIGN KEY ("ticket_work_id") REFERENCES "agent_ticket_work"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- A lease and a standing policy are two separate ways a run is bound; one
-- binding is never made under both.
ALTER TABLE "executor_bindings" ADD CONSTRAINT "executor_bindings_one_authority"
  CHECK ("standing_policy_id" IS NULL OR "lease_id" IS NULL);

-- What has already been added to `cost_usd`, by source: the newest cumulative
-- coding cost each of the record's sessions reported (`"<sessionId>": <usd>`),
-- so a status read or review adds only what is new, and each run's own cost
-- once (`"run:<runId>": <usd>`).
ALTER TABLE "agent_ticket_work"
  ADD COLUMN "session_costs" JSONB NOT NULL DEFAULT '{}';

-- `dailyUsd` is per policy per UTC day, while `agent_ticket_work.cost_usd` is
-- one record's lifetime total and cannot be split across midnight: every cost
-- added to a record under a policy is added here too, in the same statement's
-- transaction.
CREATE TABLE "executor_standing_policy_daily_spend" (
  "policy_id" UUID NOT NULL,
  "day" DATE NOT NULL,
  "cost_usd" DECIMAL(20, 8) NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "executor_standing_policy_daily_spend_pkey" PRIMARY KEY ("policy_id", "day"),
  CONSTRAINT "executor_standing_policy_daily_spend_cost_known" CHECK ("cost_usd" >= 0)
);
ALTER TABLE "executor_standing_policy_daily_spend" ADD CONSTRAINT "executor_standing_policy_daily_spend_policy_id_fkey"
  FOREIGN KEY ("policy_id") REFERENCES "executor_standing_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
