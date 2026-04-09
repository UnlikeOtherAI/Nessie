ALTER TABLE "agent_triggers"
  ADD COLUMN "scheduler_claim_id" UUID,
  ADD COLUMN "scheduler_claimed_at" TIMESTAMP(3);

CREATE INDEX "agent_triggers_type_enabled_status_next_run_at_scheduler_claimed_at_idx"
  ON "agent_triggers"("type", "enabled", "status", "next_run_at", "scheduler_claimed_at");
