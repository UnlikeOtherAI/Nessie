-- Serve the ops-health queue queries (status group-by and status='dead' ordered
-- by enqueued_at) with an index instead of a sequential scan over queue_jobs.
CREATE INDEX "queue_jobs_status_enqueued_at_idx" ON "queue_jobs"("status", "enqueued_at");
