-- Separate from the migration that added the `team` enum value: PostgreSQL
-- refuses to use a new enum value in the transaction that introduced it, and
-- Prisma runs one migration per transaction.

ALTER TABLE "cloud_browser_connections"
  DROP CONSTRAINT "cloud_browser_connections_scope_user_chk";

ALTER TABLE "cloud_browser_connections"
  ADD CONSTRAINT "cloud_browser_connections_scope_target_chk" CHECK (
    ("scope" = 'organization'::"CloudBrowserConnectionScope"
      AND "user_id" IS NULL AND "team_id" IS NULL)
    OR ("scope" = 'team'::"CloudBrowserConnectionScope"
      AND "user_id" IS NULL AND "team_id" IS NOT NULL)
    OR ("scope" = 'user'::"CloudBrowserConnectionScope"
      AND "user_id" IS NOT NULL AND "team_id" IS NULL)
  );

-- One team subscription per team, matching the organization and member rules.
CREATE UNIQUE INDEX "cloud_browser_connections_team_scope_key"
  ON "cloud_browser_connections"("team_id")
  WHERE "scope" = 'team'::"CloudBrowserConnectionScope";
