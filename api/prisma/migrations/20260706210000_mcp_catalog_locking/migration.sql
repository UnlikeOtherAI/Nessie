-- Admin locking of MCP catalog entries: members cannot self-install locked
-- connectors; owners/admins are exempt.

-- AlterTable
ALTER TABLE "mcp_catalog_entries" ADD COLUMN "locked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "mcp_catalog_entries" ADD COLUMN "locked_at" TIMESTAMP(3);
ALTER TABLE "mcp_catalog_entries" ADD COLUMN "locked_by" UUID;
