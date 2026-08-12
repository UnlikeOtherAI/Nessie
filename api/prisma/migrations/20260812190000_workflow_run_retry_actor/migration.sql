ALTER TABLE "workflow_runs" ADD COLUMN "retried_by_actor_type" TEXT;
ALTER TABLE "workflow_runs" ADD COLUMN "retried_by_actor_id" TEXT;
ALTER TABLE "workflow_runs" ADD COLUMN "retried_at" TIMESTAMP(3);
