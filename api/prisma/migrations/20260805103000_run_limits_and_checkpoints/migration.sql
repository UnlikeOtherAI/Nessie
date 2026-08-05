-- Run budgets, context lifecycle, and research routing
-- (docs/plans/2026-08-05-run-budgets-context-and-research-routing.md)
--
-- 1. agents.run_limits: optional explicit per-run caps; effort no longer
--    implies spend caps.
-- 2. runs.continuation_of_run_id: lineage for checkpoint-seeded continuation
--    runs (mirrors restart_of_run_id conventions).
-- 3. run_checkpoints: durable work-state saved at policy-ceiling stops,
--    claimed set-once via consumed_by_run_id.

-- AlterTable
ALTER TABLE "agents" ADD COLUMN "run_limits" JSONB;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN "continuation_of_run_id" UUID;

-- CreateTable
CREATE TABLE "run_checkpoints" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "task_id" UUID,
    "agent_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "root_message_id" UUID,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "sources" JSONB,
    "consumed_by_run_id" UUID,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "run_checkpoints_run_id_key" ON "run_checkpoints"("run_id");

-- CreateIndex
CREATE INDEX "run_checkpoints_thread_id_root_message_id_created_at_idx" ON "run_checkpoints"("thread_id", "root_message_id", "created_at");

-- CreateIndex
CREATE INDEX "runs_continuation_of_run_id_idx" ON "runs"("continuation_of_run_id");

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_continuation_of_run_id_fkey" FOREIGN KEY ("continuation_of_run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_checkpoints" ADD CONSTRAINT "run_checkpoints_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
