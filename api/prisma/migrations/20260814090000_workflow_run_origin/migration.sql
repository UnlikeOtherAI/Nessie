-- W25: workflow run origin — where a run was asked for, so a result can
-- return to the thread that requested it (plan §3.4 W25).
ALTER TABLE "workflow_runs" ADD COLUMN "origin_channel_id" UUID;
ALTER TABLE "workflow_runs" ADD COLUMN "origin_thread_id" UUID;
ALTER TABLE "workflow_runs" ADD COLUMN "origin_message_id" UUID;
ALTER TABLE "workflow_runs" ADD COLUMN "reply_root_message_id" UUID;

ALTER TABLE "workflow_runs"
  ADD CONSTRAINT "workflow_runs_origin_channel_id_fkey"
  FOREIGN KEY ("origin_channel_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "workflow_runs"
  ADD CONSTRAINT "workflow_runs_origin_thread_id_fkey"
  FOREIGN KEY ("origin_thread_id") REFERENCES "threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "workflow_runs"
  ADD CONSTRAINT "workflow_runs_origin_message_id_fkey"
  FOREIGN KEY ("origin_message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "workflow_runs"
  ADD CONSTRAINT "workflow_runs_reply_root_message_id_fkey"
  FOREIGN KEY ("reply_root_message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "workflow_runs_origin_channel_id_created_at_idx" ON "workflow_runs"("origin_channel_id", "created_at" DESC);
