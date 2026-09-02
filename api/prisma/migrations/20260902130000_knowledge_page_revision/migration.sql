-- Current-revision column on the knowledge page row.
--
-- Auto-saving editors need optimistic concurrency: `Dashboard.revision` and
-- `WorkflowTemplate.version` already carry it, but a knowledge page's
-- `versionNumber` lives on the per-version row (`knowledge_page_versions`), so
-- there was nothing on the page an `If-Match` could name. The page row gains
-- one, incremented on every update, and `PATCH
-- /api/knowledge-base/pages/:pageId` answers 409 when the caller's revision is
-- not the current one.
--
-- Existing rows start at 0 (NOT NULL with a constant DEFAULT, stored in the
-- catalog without a table rewrite on PostgreSQL 11+); a client that sends no
-- `If-Match` is unaffected.

-- AlterTable
ALTER TABLE "knowledge_pages" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
