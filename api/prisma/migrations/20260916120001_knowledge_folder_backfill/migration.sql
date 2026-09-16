-- Backfill: every page the old convention flagged becomes a real folder.
--
-- Separate file from the ALTER TYPE because Postgres refuses to use a new enum
-- value in the transaction that added it.
--
-- Pages that are NOT flagged but have children stay `document`: they have a
-- body, and a folder has none. They keep rendering as documents whose
-- sub-pages are reached from the open document's Sub-pages section.
UPDATE knowledge_pages
   SET kind = 'folder'
 WHERE kind = 'document'
   AND deleted_at IS NULL
   AND metadata->>'folder' = 'true';

-- A folder has no content: drop the empty versions createPage wrote for it.
-- Guarded on an empty body AND no attachment so a flagged page that somehow
-- has a real body keeps it and is reported by the verification query below,
-- never silently emptied.
DELETE FROM knowledge_page_versions v
 USING knowledge_pages p
 WHERE v.page_id = p.id
   AND p.kind = 'folder'
   AND (v.body IS NULL OR length(v.body) = 0)
   AND v.attachment_id IS NULL;

-- Folders are never published and never indexed. `status = 'published'` is how
-- a folder says it has no draft state, not a publication act.
UPDATE knowledge_pages
   SET published_version_id = NULL, status = 'published'
 WHERE kind = 'folder';

DELETE FROM knowledge_page_chunks c
 USING knowledge_pages p
 WHERE c.page_id = p.id
   AND p.kind = 'folder';

-- Verification query for the PR description — must return 0. Any row it
-- returns is a flagged page that carried real content; it is listed for a
-- human decision, never emptied by this migration.
--
--   SELECT count(*) FROM knowledge_pages p
--    WHERE p.kind = 'folder'
--      AND EXISTS (SELECT 1 FROM knowledge_page_versions v
--                   WHERE v.page_id = p.id
--                     AND (v.body <> '' OR v.attachment_id IS NOT NULL));
