-- Add unique constraint on idempotency_key to enforce at-most-once job execution
DROP INDEX IF EXISTS "queue_jobs_idempotency_key_key";
CREATE UNIQUE INDEX "queue_jobs_idempotency_key_key" ON "queue_jobs"("idempotency_key");
