-- Track workflow run retry lineage via a self-FK so operators can follow
-- a failed run forward to its retry and back to its origin.

ALTER TABLE "workflow_runs"
    ADD COLUMN "retried_from_workflow_run_id" UUID;

ALTER TABLE "workflow_runs"
    ADD CONSTRAINT "workflow_runs_retried_from_workflow_run_id_fkey"
        FOREIGN KEY ("retried_from_workflow_run_id")
        REFERENCES "workflow_runs"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "workflow_runs_retried_from_workflow_run_id_created_at_idx"
    ON "workflow_runs"("retried_from_workflow_run_id", "created_at" DESC);
