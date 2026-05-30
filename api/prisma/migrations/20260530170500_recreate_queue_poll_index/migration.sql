-- idx_queue_jobs_poll is the partial index that serves the SQL-backed queue
-- dequeue (topic + status filter scoped to in-flight rows). It was created in
-- 20260408000223_phase1_step1_init but is absent from schema.prisma because
-- Prisma cannot express partial indexes. This migration recreates it
-- idempotently so the index definition lives in a tracked migration and a fresh
-- shadow/dev database rebuilt purely from migrations still has it.
--
-- NOTE: Prisma's model-vs-database diff may still report this partial index as
-- drift (it has no schema representation). That is a known Prisma limitation,
-- not a missing index — do not let `prisma migrate diff` "fix" it by dropping.
--
-- PRODUCTION: use CREATE INDEX CONCURRENTLY here (cannot run inside Prisma's
-- migration transaction). Flagged for the deploy runbook.
DROP INDEX IF EXISTS "idx_queue_jobs_poll";
CREATE INDEX "idx_queue_jobs_poll"
  ON "queue_jobs" ("topic", "status", "locked_until")
  WHERE "status" IN ('pending', 'processing');
