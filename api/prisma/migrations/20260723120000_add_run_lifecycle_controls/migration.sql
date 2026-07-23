-- Active run lifecycle controls: cooperative cancel, restart linkage, and the
-- trigger-message backlink that the cancel handoff-guard and restart replay use.

ALTER TABLE "runs"
  ADD COLUMN "cancel_requested_at" TIMESTAMP(3),
  ADD COLUMN "cancel_requested_by_user_id" UUID,
  ADD COLUMN "trigger_message_id" UUID,
  ADD COLUMN "restart_of_run_id" UUID;

ALTER TABLE "runs"
  ADD CONSTRAINT "runs_cancel_requested_by_user_id_fkey"
    FOREIGN KEY ("cancel_requested_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "runs"
  ADD CONSTRAINT "runs_trigger_message_id_fkey"
    FOREIGN KEY ("trigger_message_id") REFERENCES "messages"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "runs"
  ADD CONSTRAINT "runs_restart_of_run_id_fkey"
    FOREIGN KEY ("restart_of_run_id") REFERENCES "runs"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "runs_restart_of_run_id_idx" ON "runs"("restart_of_run_id");
