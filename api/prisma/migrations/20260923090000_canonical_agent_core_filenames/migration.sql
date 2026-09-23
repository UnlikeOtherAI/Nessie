-- The roles remain the durable identity. Rename the human-facing page and
-- every immutable source attachment in place so history and run snapshots keep
-- their existing ids while all surfaces use the canonical filenames.
UPDATE "knowledge_pages" AS page
SET "title" = CASE core."role"::text
  WHEN 'identity' THEN 'AGENTS.md'
  WHEN 'working_rules' THEN 'personality.md'
END
FROM "agent_core_documents" AS core
WHERE core."page_id" = page."id"
  AND page."title" IS DISTINCT FROM CASE core."role"::text
    WHEN 'identity' THEN 'AGENTS.md'
    WHEN 'working_rules' THEN 'personality.md'
  END;

UPDATE "attachments" AS attachment
SET "filename" = CASE core."role"::text
  WHEN 'identity' THEN 'AGENTS.md'
  WHEN 'working_rules' THEN 'personality.md'
END
FROM "knowledge_page_versions" AS version
JOIN "agent_core_documents" AS core ON core."page_id" = version."page_id"
WHERE version."attachment_id" = attachment."id"
  AND attachment."filename" IS DISTINCT FROM CASE core."role"::text
    WHEN 'identity' THEN 'AGENTS.md'
    WHEN 'working_rules' THEN 'personality.md'
  END;
