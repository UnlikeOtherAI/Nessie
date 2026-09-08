-- A document's current page envelope remains its home entitlement. These rows
-- carry the narrower, immutable source basis of each version derived from a
-- private conversation or another restricted source.
CREATE TABLE "knowledge_page_version_basis_scopes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_page_version_basis_scopes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "knowledge_page_version_disclosure_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source_channel_id" UUID NOT NULL,
    "source_author_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_page_version_disclosure_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "knowledge_page_version_basis_scopes_version_scope_key"
  ON "knowledge_page_version_basis_scopes"("version_id", "scope_type", "scope_id");
CREATE INDEX "knowledge_page_version_basis_scopes_org_idx"
  ON "knowledge_page_version_basis_scopes"("organization_id");

-- NULL is a durable "unknown original author" marker, so it must deduplicate
-- too. PostgreSQL 16's NULLS NOT DISTINCT is the structural form Prisma cannot
-- express in its schema DSL.
CREATE UNIQUE INDEX "knowledge_page_version_source_lineage_idx"
  ON "knowledge_page_version_disclosure_sources"(
    "version_id", "source_channel_id", "source_author_user_id"
  ) NULLS NOT DISTINCT;
CREATE INDEX "knowledge_page_version_disclosure_sources_org_idx"
  ON "knowledge_page_version_disclosure_sources"("organization_id");

ALTER TABLE "knowledge_page_version_basis_scopes"
  ADD CONSTRAINT "knowledge_page_version_basis_version_fkey"
  FOREIGN KEY ("version_id") REFERENCES "knowledge_page_versions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_page_version_basis_scopes"
  ADD CONSTRAINT "knowledge_page_version_basis_organization_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_page_version_disclosure_sources"
  ADD CONSTRAINT "knowledge_page_version_source_version_fkey"
  FOREIGN KEY ("version_id") REFERENCES "knowledge_page_versions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_page_version_disclosure_sources"
  ADD CONSTRAINT "knowledge_page_version_source_organization_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_page_version_disclosure_sources"
  ADD CONSTRAINT "knowledge_page_version_source_channel_fkey"
  FOREIGN KEY ("source_channel_id") REFERENCES "channels"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_page_version_disclosure_sources"
  ADD CONSTRAINT "knowledge_page_version_source_author_fkey"
  FOREIGN KEY ("source_author_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- A source author may be erased. Keep the per-(version, channel) unknown marker
-- without letting a second author deletion collide with the NULLS NOT DISTINCT
-- lineage index: the last erased author replaces any earlier null marker.
CREATE FUNCTION collapse_knowledge_version_unknown_source_author()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.source_author_user_id IS NOT NULL AND NEW.source_author_user_id IS NULL THEN
    DELETE FROM knowledge_page_version_disclosure_sources
    WHERE version_id = NEW.version_id
      AND source_channel_id = NEW.source_channel_id
      AND source_author_user_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_version_source_author_delete_unknown
BEFORE UPDATE OF source_author_user_id
ON knowledge_page_version_disclosure_sources
FOR EACH ROW
EXECUTE FUNCTION collapse_knowledge_version_unknown_source_author();

-- Repair only versions with a provable worker write origin. A knowledge.embed job
-- binds the immutable version id to the producing run and agent; do not infer a
-- run from a matching author or page. Every INSERT is idempotent, so a deploy
-- retried after interruption converges without widening any document.
WITH legacy_runs AS (
  SELECT DISTINCT v.id AS version_id, p.organization_id, r.id AS run_id
  FROM knowledge_page_versions v
  JOIN knowledge_pages p ON p.id = v.page_id
  JOIN queue_jobs j ON j.topic = 'knowledge.embed'
    AND j.payload ->> 'versionId' = v.id::text
    AND j.payload ->> 'organizationId' = p.organization_id::text
    AND jsonb_typeof(j.payload -> 'origin') = 'object'
    AND (j.payload -> 'origin' ->> 'runId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  JOIN runs r ON r.id = (j.payload -> 'origin' ->> 'runId')::uuid
    AND r.agent_id::text = v.author_id
  JOIN threads run_thread ON run_thread.id = r.thread_id
  JOIN channels run_channel ON run_channel.id = run_thread.channel_id
    AND run_channel.organization_id = p.organization_id
  WHERE v.author_type = 'agent'::"KnowledgeAuthorType"
)
INSERT INTO knowledge_page_version_basis_scopes (
  id, version_id, organization_id, scope_type, scope_id, created_at
)
SELECT gen_random_uuid(), legacy_runs.version_id, legacy_runs.organization_id,
       basis.scope_type, basis.scope_id, now()
FROM legacy_runs
JOIN run_basis_scopes basis
  ON basis.run_id = legacy_runs.run_id
  AND basis.organization_id = legacy_runs.organization_id
ON CONFLICT (version_id, scope_type, scope_id) DO NOTHING;

-- Preserve only durable original authors from the producing run's checkpoint.
-- Checkpoints are the canonical run-attached source carrier; do not guess from
-- channel membership, current agent ownership, or a later message.
WITH legacy_runs AS (
  SELECT DISTINCT v.id AS version_id, p.organization_id, r.id AS run_id
  FROM knowledge_page_versions v
  JOIN knowledge_pages p ON p.id = v.page_id
  JOIN queue_jobs j ON j.topic = 'knowledge.embed'
    AND j.payload ->> 'versionId' = v.id::text
    AND j.payload ->> 'organizationId' = p.organization_id::text
    AND jsonb_typeof(j.payload -> 'origin') = 'object'
    AND (j.payload -> 'origin' ->> 'runId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  JOIN runs r ON r.id = (j.payload -> 'origin' ->> 'runId')::uuid
    AND r.agent_id::text = v.author_id
  JOIN threads run_thread ON run_thread.id = r.thread_id
  JOIN channels run_channel ON run_channel.id = run_thread.channel_id
    AND run_channel.organization_id = p.organization_id
  WHERE v.author_type = 'agent'::"KnowledgeAuthorType"
)
INSERT INTO knowledge_page_version_disclosure_sources (
  id, version_id, organization_id, source_channel_id, source_author_user_id, created_at
)
SELECT gen_random_uuid(), legacy_runs.version_id, legacy_runs.organization_id,
       source.source_channel_id, source.source_author_user_id, now()
FROM legacy_runs
JOIN run_checkpoints checkpoint ON checkpoint.run_id = legacy_runs.run_id
JOIN run_checkpoint_disclosure_sources source
  ON source.checkpoint_id = checkpoint.id
  AND source.organization_id = legacy_runs.organization_id
ON CONFLICT (version_id, source_channel_id, source_author_user_id) DO NOTHING;

-- A provably private source channel with no durable author lineage remains a
-- restricted document, represented by its explicit unknown marker. Public and
-- protected runs, and versions without the exact job-to-run proof above, stay
-- untouched; this is a bounded repair, never a blanket legacy restriction.
WITH legacy_runs AS (
  SELECT DISTINCT v.id AS version_id, p.organization_id, r.id AS run_id
  FROM knowledge_page_versions v
  JOIN knowledge_pages p ON p.id = v.page_id
  JOIN queue_jobs j ON j.topic = 'knowledge.embed'
    AND j.payload ->> 'versionId' = v.id::text
    AND j.payload ->> 'organizationId' = p.organization_id::text
    AND jsonb_typeof(j.payload -> 'origin') = 'object'
    AND (j.payload -> 'origin' ->> 'runId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  JOIN runs r ON r.id = (j.payload -> 'origin' ->> 'runId')::uuid
    AND r.agent_id::text = v.author_id
  JOIN threads run_thread ON run_thread.id = r.thread_id
  JOIN channels run_channel ON run_channel.id = run_thread.channel_id
    AND run_channel.organization_id = p.organization_id
  WHERE v.author_type = 'agent'::"KnowledgeAuthorType"
)
INSERT INTO knowledge_page_version_disclosure_sources (
  id, version_id, organization_id, source_channel_id, source_author_user_id, created_at
)
SELECT gen_random_uuid(), legacy_runs.version_id, legacy_runs.organization_id,
       basis.scope_id, NULL, now()
FROM legacy_runs
JOIN run_basis_scopes basis
  ON basis.run_id = legacy_runs.run_id
  AND basis.organization_id = legacy_runs.organization_id
  AND basis.scope_type = 'channel'
JOIN channels source_channel
  ON source_channel.id = basis.scope_id
  AND source_channel.organization_id = legacy_runs.organization_id
  AND source_channel.visibility = 'private'::"ChannelVisibility"
WHERE NOT EXISTS (
  SELECT 1
  FROM run_checkpoints checkpoint
  JOIN run_checkpoint_disclosure_sources source
    ON source.checkpoint_id = checkpoint.id
    AND source.organization_id = legacy_runs.organization_id
  WHERE checkpoint.run_id = legacy_runs.run_id
    AND source.source_channel_id = basis.scope_id
)
ON CONFLICT (version_id, source_channel_id, source_author_user_id) DO NOTHING;
