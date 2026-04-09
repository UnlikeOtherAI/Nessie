ALTER TABLE "agent_triggers"
  ADD COLUMN "target_channel_id" UUID,
  ADD COLUMN "target_thread_id" UUID;

ALTER TABLE "agent_trigger_deliveries"
  ADD COLUMN "dedupe_key" TEXT;

CREATE INDEX "agent_triggers_type_enabled_status_next_run_at_idx"
  ON "agent_triggers"("type", "enabled", "status", "next_run_at");
CREATE INDEX "agent_triggers_target_channel_id_idx"
  ON "agent_triggers"("target_channel_id");
CREATE INDEX "agent_triggers_target_thread_id_idx"
  ON "agent_triggers"("target_thread_id");

CREATE UNIQUE INDEX "agent_trigger_deliveries_trigger_id_dedupe_key_key"
  ON "agent_trigger_deliveries"("trigger_id", "dedupe_key");

ALTER TABLE "agent_triggers"
  ADD CONSTRAINT "agent_triggers_target_channel_id_fkey"
    FOREIGN KEY ("target_channel_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_triggers_target_thread_id_fkey"
    FOREIGN KEY ("target_thread_id") REFERENCES "threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
