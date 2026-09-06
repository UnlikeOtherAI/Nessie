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
--
-- Plain CREATE INDEX, not CONCURRENTLY, deliberately. A plain build takes a
-- SHARE lock for its duration, which blocks writers to this table — acceptable
-- here because the partial predicate means the build scans only the handful of
-- rows currently open, and the writers it can block are document-session
-- inserts and status flips, not user traffic. CONCURRENTLY is the answer when
-- the build is long, and it costs something: it cannot run inside a
-- transaction, so it does not fit `prisma migrate deploy`'s per-migration
-- transaction and would have to be split out and made re-runnable by hand
-- (a failed concurrent build leaves an INVALID index behind). If this table
-- ever carries a large open backlog — a long incident, or a change that keeps
-- sessions open — reach for CONCURRENTLY then, and take the split-out
-- machinery with it.
CREATE INDEX IF NOT EXISTS "run_document_sessions_open_updated_at_idx"
  ON "run_document_sessions" ("updated_at")
  WHERE "status" IN ('streaming', 'saving');
