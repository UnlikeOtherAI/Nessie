-- MCP App Store: personal (private) connectors + public submit/approve flow.
-- Spec: docs/plans/2026-05-30-mcp-store-publishing-approval.md
--
-- Adds a visibility tier (private | public), per-entry ownership, and the
-- approval audit trail. Private connectors are self-serve (draft -> published);
-- public connectors require a superuser to approve a pending_approval
-- submission. Uniqueness moves to partial indexes because a single composite
-- key cannot express "public names are unique store-wide" AND "private names
-- are unique per owner".

-- CreateEnum
CREATE TYPE "McpCatalogVisibility" AS ENUM ('private', 'public');

-- AlterTable
ALTER TABLE "mcp_catalog_entries"
  ADD COLUMN "visibility" "McpCatalogVisibility" NOT NULL DEFAULT 'private',
  ADD COLUMN "owner_user_id" UUID,
  ADD COLUMN "submitted_at" TIMESTAMP(3),
  ADD COLUMN "reviewed_at" TIMESTAMP(3),
  ADD COLUMN "reviewed_by" UUID,
  ADD COLUMN "rejection_reason" TEXT;

-- Backfill: rows that predate this migration were admin-managed catalog
-- definitions meant to be broadly visible, so they become public store
-- entries (ownerless). New rows default to private per the column default.
UPDATE "mcp_catalog_entries" SET "visibility" = 'public';

-- Replace the old composite unique ([organization_id, name]) with the two
-- partial unique indexes the visibility model needs.
DROP INDEX IF EXISTS "mcp_catalog_entries_organization_id_name_key";

CREATE UNIQUE INDEX "mcp_catalog_entries_public_name_key"
  ON "mcp_catalog_entries" ("name")
  WHERE "visibility" = 'public';

CREATE UNIQUE INDEX "mcp_catalog_entries_owner_name_key"
  ON "mcp_catalog_entries" ("owner_user_id", "name")
  WHERE "visibility" = 'private';

-- CreateIndex
CREATE INDEX "mcp_catalog_entries_owner_user_id_status_idx"
  ON "mcp_catalog_entries" ("owner_user_id", "status");

CREATE INDEX "mcp_catalog_entries_visibility_status_idx"
  ON "mcp_catalog_entries" ("visibility", "status");
