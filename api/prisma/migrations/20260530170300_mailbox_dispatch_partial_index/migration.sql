-- The worker mailbox dispatch poll runs:
--   WHERE status = 'queued' AND visible_at <= now() AND to_agent_id IS NOT NULL
--   ORDER BY visible_at, created_at
-- None of the existing indexes (which lead with organization_id / to_agent_id /
-- thread_id) serve this ordered, status-and-recipient-filtered scan. Add a
-- partial index ordered by (visible_at, created_at) restricted to the exact
-- predicate so the poll is an index range scan instead of a heap scan.
--
-- Prisma cannot express partial indexes, so this is raw SQL and the schema only
-- carries a documenting comment.
--
-- PRODUCTION: use CREATE INDEX CONCURRENTLY here (cannot run inside Prisma's
-- migration transaction). Flagged for the deploy runbook.
CREATE INDEX "idx_agent_mailbox_messages_dispatch"
  ON "agent_mailbox_messages" ("visible_at", "created_at")
  WHERE "status" = 'queued' AND "to_agent_id" IS NOT NULL;
