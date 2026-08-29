-- MCP App Store: a store dimension over the existing connector catalogue.
--
-- The App Store is a second FACE on `mcp_catalog_entries`, never a second
-- catalogue. Everything below is additive: no existing column changes type,
-- no existing index is dropped, and every new column is nullable or carries a
-- default, so already-installed connectors keep working untouched.

-- ─── Enums ───

CREATE TYPE "McpAppCategory" AS ENUM (
  'communication',
  'development',
  'productivity',
  'crm_sales',
  'project_management',
  'customer_support',
  'data_databases',
  'analytics',
  'finance',
  'marketing',
  'files_documents',
  'ai_search',
  'infrastructure',
  'commerce',
  'other'
);

CREATE TYPE "McpAppTrustLevel" AS ENUM (
  'nessie',
  'verified',
  'community',
  'unknown',
  'blocked'
);

CREATE TYPE "McpAppModerationState" AS ENUM (
  'discovered',
  'curated',
  'approved',
  'hidden',
  'blocked'
);

CREATE TYPE "McpAppSource" AS ENUM ('nessie', 'mcp_registry', 'custom');

CREATE TYPE "McpAppDistribution" AS ENUM ('remote', 'package', 'builtin');

-- ─── Store columns on the catalogue ───

ALTER TABLE "mcp_catalog_entries"
  ADD COLUMN "slug"                TEXT,
  ADD COLUMN "display_name"        TEXT,
  ADD COLUMN "short_description"   TEXT,
  ADD COLUMN "long_description"    TEXT,
  ADD COLUMN "website_url"         TEXT,
  ADD COLUMN "documentation_url"   TEXT,
  ADD COLUMN "repository_url"      TEXT,
  ADD COLUMN "icon_attachment_id"  UUID,
  ADD COLUMN "icon_source"         TEXT,
  ADD COLUMN "primary_category"    "McpAppCategory" NOT NULL DEFAULT 'other',
  ADD COLUMN "categories"          "McpAppCategory"[] NOT NULL DEFAULT ARRAY[]::"McpAppCategory"[],
  ADD COLUMN "tags"                TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "aliases"             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "trust_level"         "McpAppTrustLevel" NOT NULL DEFAULT 'unknown',
  ADD COLUMN "moderation_state"    "McpAppModerationState" NOT NULL DEFAULT 'discovered',
  ADD COLUMN "app_source"          "McpAppSource" NOT NULL DEFAULT 'nessie',
  ADD COLUMN "distribution"        "McpAppDistribution" NOT NULL DEFAULT 'remote',
  ADD COLUMN "featured"            BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "featured_order"      INTEGER,
  ADD COLUMN "registry_name"       TEXT,
  ADD COLUMN "registry_version"    TEXT,
  ADD COLUMN "upstream"            JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "upstream_updated_at" TIMESTAMP(3),
  ADD COLUMN "tool_count"          INTEGER,
  ADD COLUMN "resource_count"      INTEGER,
  ADD COLUMN "prompt_count"        INTEGER,
  ADD COLUMN "capabilities_at"     TIMESTAMP(3);

-- Every connector that already exists predates the store and was authored by
-- a human in this instance, so it is `nessie`-sourced rather than discovered
-- from a registry. Its moderation state follows the review state it already
-- earned: a published public entry has been through approval, everything else
-- is curated-but-not-public. This is what makes existing connectors appear in
-- the store immediately instead of sitting invisible in `discovered`.
UPDATE "mcp_catalog_entries"
SET "moderation_state" = CASE
      WHEN "visibility" = 'public' AND "status" = 'published' THEN 'approved'::"McpAppModerationState"
      WHEN "status" = 'deprecated' THEN 'hidden'::"McpAppModerationState"
      ELSE 'curated'::"McpAppModerationState"
    END,
    "app_source" = 'nessie'::"McpAppSource",
    -- `ws` never had a working client and `stdio` is refused for user-authored
    -- connectors, so anything not http/sse is not a reachable remote.
    "distribution" = CASE
      WHEN "protocol" IN ('http', 'sse') THEN 'remote'::"McpAppDistribution"
      ELSE 'builtin'::"McpAppDistribution"
    END;

-- Backfill `slug` from `name`, which is already unique among public entries.
-- Private entries are unique only per owner, so they can genuinely collide;
-- those get a short disambiguating suffix from the id rather than being left
-- null, so every existing app is addressable at `/apps/:slug` on day one.
UPDATE "mcp_catalog_entries" AS e
SET "slug" = CASE
      WHEN dupe.n = 1 THEN slugified.s
      ELSE slugified.s || '-' || substring(replace(e."id"::text, '-', '') FROM 1 FOR 6)
    END
FROM (
  SELECT
    "id",
    NULLIF(regexp_replace(lower(trim("name")), '[^a-z0-9]+', '-', 'g'), '') AS s
  FROM "mcp_catalog_entries"
) AS slugified,
LATERAL (
  SELECT count(*) AS n
  FROM (
    SELECT NULLIF(regexp_replace(lower(trim("name")), '[^a-z0-9]+', '-', 'g'), '') AS s2
    FROM "mcp_catalog_entries"
  ) AS all_slugs
  WHERE all_slugs.s2 = slugified.s
) AS dupe
WHERE e."id" = slugified."id"
  AND slugified.s IS NOT NULL;

-- Trim any leading/trailing separators the regexp above can leave behind
-- (a name like "--Foo--" slugifies to "-foo-").
UPDATE "mcp_catalog_entries"
SET "slug" = trim(BOTH '-' FROM "slug")
WHERE "slug" IS NOT NULL AND "slug" <> trim(BOTH '-' FROM "slug");

UPDATE "mcp_catalog_entries" SET "slug" = NULL WHERE "slug" = '';

CREATE UNIQUE INDEX "mcp_catalog_entries_slug_key"
  ON "mcp_catalog_entries" ("slug");

-- ─── Weighted full-text search ───
--
-- Maintained by a trigger, NOT by application code and NOT as a GENERATED
-- column. A trigger fires on every insert and update, so the vector cannot
-- drift from the row it describes — but unlike `GENERATED ALWAYS AS … STORED`
-- it carries no immutability requirement, and the expression below genuinely
-- is not immutable: `array_to_string` is only STABLE (an array's element
-- output function is not guaranteed immutable), so Postgres rejects it in a
-- generated column with `42P17: generation expression is not immutable`.
--
-- Weights encode the ranking the store needs: an app's own name and its
-- curated aliases are A (this is how "email" reaches Gmail), the provider is
-- B, tags are C, and prose is D — so a name match always outranks any number
-- of description hits. Identifier-ish fields use the `simple` dictionary so a
-- product name is not stemmed into a different word; prose uses `english`.
ALTER TABLE "mcp_catalog_entries" ADD COLUMN "search_vector" tsvector;

CREATE OR REPLACE FUNCTION "mcp_catalog_entries_search_vector_refresh"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."search_vector" :=
    setweight(to_tsvector('simple', coalesce(NEW."display_name", NEW."label", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW."name", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(array_to_string(NEW."aliases", ' '), '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW."vendor", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(array_to_string(NEW."tags", ' '), '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW."short_description", NEW."description", '')), 'D') ||
    setweight(to_tsvector('english', coalesce(NEW."long_description", '')), 'D');
  RETURN NEW;
END;
$$;

CREATE TRIGGER "mcp_catalog_entries_search_vector_trg"
  BEFORE INSERT OR UPDATE ON "mcp_catalog_entries"
  FOR EACH ROW
  EXECUTE FUNCTION "mcp_catalog_entries_search_vector_refresh"();

-- Backfill every existing row through the same expression the trigger uses.
UPDATE "mcp_catalog_entries" SET "search_vector" = NULL;

CREATE INDEX "mcp_catalog_entries_search_vector_idx"
  ON "mcp_catalog_entries" USING GIN ("search_vector");

-- Trigram index on the display name so a mistyped query ("githb") can still
-- fall back to similarity when the tsquery returns nothing.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "mcp_catalog_entries_name_trgm_idx"
  ON "mcp_catalog_entries" USING GIN (lower(coalesce("display_name", "label")) gin_trgm_ops);

-- ─── Store read indexes ───

CREATE INDEX "mcp_catalog_entries_moderation_state_trust_level_idx"
  ON "mcp_catalog_entries" ("moderation_state", "trust_level");

CREATE INDEX "mcp_catalog_entries_primary_category_moderation_state_idx"
  ON "mcp_catalog_entries" ("primary_category", "moderation_state");

CREATE INDEX "mcp_catalog_entries_featured_featured_order_idx"
  ON "mcp_catalog_entries" ("featured", "featured_order");

-- ─── Registry sync runs ───

CREATE TABLE "mcp_registry_sync_runs" (
  "id"              UUID NOT NULL,
  "source"          TEXT NOT NULL DEFAULT 'mcp-registry',
  "started_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at"    TIMESTAMP(3),
  "servers_fetched" INTEGER NOT NULL DEFAULT 0,
  "servers_created" INTEGER NOT NULL DEFAULT 0,
  "servers_updated" INTEGER NOT NULL DEFAULT 0,
  "servers_failed"  INTEGER NOT NULL DEFAULT 0,
  "icons_cached"    INTEGER NOT NULL DEFAULT 0,
  "error"           TEXT,
  "failures"        JSONB NOT NULL DEFAULT '[]',

  CONSTRAINT "mcp_registry_sync_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mcp_registry_sync_runs_started_at_idx"
  ON "mcp_registry_sync_runs" ("started_at");

CREATE INDEX "mcp_registry_sync_runs_completed_at_idx"
  ON "mcp_registry_sync_runs" ("completed_at");

-- ─── Server health ───

CREATE TABLE "mcp_server_health" (
  "catalog_entry_id"           UUID NOT NULL,
  "reachable"                  BOOLEAN NOT NULL DEFAULT false,
  "initialization_successful"  BOOLEAN NOT NULL DEFAULT false,
  "latency_ms"                 INTEGER,
  "tool_count"                 INTEGER,
  "resource_count"             INTEGER,
  "prompt_count"               INTEGER,
  "checked_at"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "error"                      TEXT,

  CONSTRAINT "mcp_server_health_pkey" PRIMARY KEY ("catalog_entry_id")
);

CREATE INDEX "mcp_server_health_checked_at_idx"
  ON "mcp_server_health" ("checked_at");

ALTER TABLE "mcp_server_health"
  ADD CONSTRAINT "mcp_server_health_catalog_entry_id_fkey"
  FOREIGN KEY ("catalog_entry_id") REFERENCES "mcp_catalog_entries"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
