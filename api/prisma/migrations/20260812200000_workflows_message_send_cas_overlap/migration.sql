-- AlterEnum
ALTER TYPE "AgentTriggerDeliveryStatus" ADD VALUE 'skipped_overlap';

-- AlterTable
ALTER TABLE "workflow_installations" ADD COLUMN "concurrency" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "workflow_state_entries" ADD COLUMN "writer_attempt" INTEGER;

-- Backfill (W18): the writer of the current version of pre-existing entries
-- is the run/step recorded on the row, at attempt 1 (the only attempt that
-- existed before the counter).
UPDATE "workflow_state_entries"
SET "writer_attempt" = 1
WHERE "workflow_step_run_id" IS NOT NULL;
