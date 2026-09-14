-- Every app is public within its organisation for now; private apps come later
-- and keep the `visibility` column. Public names were unique instance-wide,
-- which meant one tenant's app could block another tenant's (or a registry
-- row) of the same name. Instance-global rows keep that rule; tenant rows are
-- unique per organisation.

DROP INDEX IF EXISTS "mcp_catalog_entries_public_name_key";

CREATE UNIQUE INDEX "mcp_catalog_entries_public_name_key"
  ON "mcp_catalog_entries" ("name")
  WHERE "visibility" = 'public' AND "organization_id" IS NULL;

CREATE UNIQUE INDEX "mcp_catalog_entries_organization_public_name_key"
  ON "mcp_catalog_entries" ("organization_id", "name")
  WHERE "visibility" = 'public' AND "organization_id" IS NOT NULL;

-- Share the apps people already published privately (custom apps, library
-- imports). Rejected, deprecated, hidden and blocked rows stay as they are.
-- Where two members published the same name, the oldest becomes the shared
-- app and the others stay private to their owners rather than failing the
-- migration on the new index.
WITH candidates AS (
  SELECT
    e."id",
    row_number() OVER (
      PARTITION BY e."organization_id", e."name"
      ORDER BY e."created_at", e."id"
    ) AS rank
  FROM "mcp_catalog_entries" e
  WHERE e."organization_id" IS NOT NULL
    AND e."visibility" = 'private'
    AND e."status" = 'published'
    AND e."moderation_state" NOT IN ('hidden', 'blocked')
    AND NOT EXISTS (
      SELECT 1
      FROM "mcp_catalog_entries" p
      WHERE p."organization_id" = e."organization_id"
        AND p."name" = e."name"
        AND p."visibility" = 'public'
    )
)
UPDATE "mcp_catalog_entries" e
SET "visibility" = 'public', "updated_at" = now()
FROM candidates c
WHERE e."id" = c."id" AND c.rank = 1;
