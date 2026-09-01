-- Private catalogue entries are visible and resolved within one organisation.
-- Keep matching names independent across a person's separate workspaces; the
-- previous owner-wide index made an invisible entry in one workspace block the
-- same person from adding it in another.

DROP INDEX IF EXISTS "mcp_catalog_entries_owner_name_key";

CREATE UNIQUE INDEX "mcp_catalog_entries_organization_owner_name_key"
  ON "mcp_catalog_entries" ("organization_id", "owner_user_id", "name")
  WHERE "visibility" = 'private';
