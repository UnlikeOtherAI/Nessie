-- A failed workflow run needs durable attention even when no device can receive
-- a push. The relation supplies both lifecycle cleanup and read-time
-- revalidation against the exact run.
ALTER TYPE "UserAlertKind" ADD VALUE IF NOT EXISTS 'workflow_run_failed';

ALTER TABLE "user_alerts"
  ADD COLUMN "workflow_run_id" UUID;

ALTER TABLE "user_alerts"
  ADD CONSTRAINT "user_alerts_workflow_run_id_fkey"
  FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "user_alerts_workflow_run_id_idx"
  ON "user_alerts"("workflow_run_id");
