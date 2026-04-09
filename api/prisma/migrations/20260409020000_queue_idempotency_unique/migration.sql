-- Add unique constraint on idempotency_key to enforce at-most-once job execution
CREATE UNIQUE INDEX "queue_jobs_idempotency_key_key" ON "queue_jobs"("idempotency_key");
