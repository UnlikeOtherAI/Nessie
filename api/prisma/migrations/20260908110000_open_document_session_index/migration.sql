-- The document-session reaper's read: open sessions, oldest first
-- (`worker/src/control/document-session-reaper.ts`). It runs once a minute for
-- the whole cluster and `run_document_sessions` is never pruned, so without an
-- index the pass is a sequential scan over every document any agent has ever
-- written, growing for ever.
--
-- Partial on the two open statuses, which is what makes it worth having: all
-- but a handful of rows are terminal at any moment, so the index holds only the
-- sessions currently in flight and costs an entry only while one is. The
-- predicate is not expressible in the Prisma schema, so this index lives only
-- here — the same arrangement as `idx_queue_jobs_poll`.
--
-- Additive and unread by any deployed build: safe to apply before a blue-green
-- swap, while the previous image still serves.
CREATE INDEX IF NOT EXISTS "run_document_sessions_open_updated_at_idx"
  ON "run_document_sessions" ("updated_at")
  WHERE "status" IN ('streaming', 'saving');
