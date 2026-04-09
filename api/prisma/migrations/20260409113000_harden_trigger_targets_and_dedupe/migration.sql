ALTER TABLE "agent_triggers"
  ADD COLUMN "target_channel_id" UUID,
  ADD COLUMN "target_thread_id" UUID;

ALTER TABLE "agent_trigger_deliveries"
  ADD COLUMN "dedupe_key" TEXT;

CREATE INDEX "agent_triggers_type_enabled_status_next_run_at_idx"
  ON "agent_triggers"("type", "enabled", "status", "next_run_at");

CREATE UNIQUE INDEX "agent_trigger_deliveries_trigger_id_dedupe_key_key"
  ON "agent_trigger_deliveries"("trigger_id", "dedupe_key");
