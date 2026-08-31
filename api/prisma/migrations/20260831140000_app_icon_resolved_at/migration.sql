-- An app's icon is resolved lazily, on first view, and the result is shared by
-- the whole instance. This column records that the attempt happened at all.
--
-- Without it a site with no usable favicon would be re-fetched on every page
-- view forever: the store would quietly become a crawler paced by how often
-- people browse. NULL means "never tried"; a timestamp with a NULL
-- icon_attachment_id means "tried, nothing usable" — the monogram is the
-- answer, and it is a legitimate final state rather than a failure.
--
-- Nullable with no backfill: every one of the ~5,500 existing rows has
-- genuinely never been tried, so NULL is already the truthful value for them.
ALTER TABLE "mcp_catalog_entries" ADD COLUMN "icon_resolved_at" TIMESTAMP(3);

-- The store asks "which rows can still be resolved?" on every catalogue page.
-- Plain, not CONCURRENTLY: Prisma runs a migration inside a transaction, where
-- CONCURRENTLY is illegal. The lint's CONCURRENTLY warning covers the hot
-- append-only tables (messages, task_events, runs, audit_logs); this one is a
-- ~5,500-row catalogue, so the brief lock is not worth a two-step migration.
CREATE INDEX IF NOT EXISTS "mcp_catalog_entries_icon_resolved_at_idx"
  ON "mcp_catalog_entries" ("icon_resolved_at")
  WHERE "icon_attachment_id" IS NULL;
