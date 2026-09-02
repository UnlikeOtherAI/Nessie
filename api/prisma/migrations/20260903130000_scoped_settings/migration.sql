-- Settings resolved across organisation → team → person, with locks.

CREATE TYPE "SettingScope" AS ENUM ('organization', 'team', 'user');

CREATE TABLE "scoped_settings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "scope" "SettingScope" NOT NULL,
    "team_id" UUID,
    "user_id" UUID,
    "key" TEXT NOT NULL,
    "value" JSONB,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scoped_settings_pkey" PRIMARY KEY ("id")
);

-- The scope column and its target must agree, or the resolver would read a row
-- at a level it was never written for.
ALTER TABLE "scoped_settings"
  ADD CONSTRAINT "scoped_settings_scope_target_chk" CHECK (
    ("scope" = 'organization'::"SettingScope" AND "team_id" IS NULL AND "user_id" IS NULL)
    OR ("scope" = 'team'::"SettingScope" AND "team_id" IS NOT NULL AND "user_id" IS NULL)
    OR ("scope" = 'user'::"SettingScope" AND "team_id" IS NULL AND "user_id" IS NOT NULL)
  );

-- One row per key per level. Postgres treats NULLs as distinct, so a plain
-- UNIQUE across the target columns would let a level accumulate rows for one
-- key and make resolution depend on insertion order.
CREATE UNIQUE INDEX "scoped_settings_org_scope_key"
  ON "scoped_settings"("organization_id", "key")
  WHERE "scope" = 'organization'::"SettingScope";

CREATE UNIQUE INDEX "scoped_settings_team_scope_key"
  ON "scoped_settings"("team_id", "key")
  WHERE "scope" = 'team'::"SettingScope";

CREATE UNIQUE INDEX "scoped_settings_user_scope_key"
  ON "scoped_settings"("organization_id", "user_id", "key")
  WHERE "scope" = 'user'::"SettingScope";

CREATE INDEX "scoped_settings_organization_id_key_idx"
  ON "scoped_settings"("organization_id", "key");

ALTER TABLE "scoped_settings"
  ADD CONSTRAINT "scoped_settings_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "scoped_settings"
  ADD CONSTRAINT "scoped_settings_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenancy at the storage boundary: a user-scoped row's owner must be a member
-- of this organization. NO ACTION rather than SET NULL because on a composite
-- key SET NULL blanks every referencing column, organization_id included.
ALTER TABLE "scoped_settings"
  ADD CONSTRAINT "scoped_settings_owner_fkey"
  FOREIGN KEY ("organization_id", "user_id")
  REFERENCES "organization_members"("organization_id", "user_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- A cloud browser connection may now belong to a team, between the
-- organisation subscription and a personal one.
ALTER TYPE "CloudBrowserConnectionScope" ADD VALUE IF NOT EXISTS 'team';

ALTER TABLE "cloud_browser_connections" ADD COLUMN "team_id" UUID;

ALTER TABLE "cloud_browser_connections"
  ADD CONSTRAINT "cloud_browser_connections_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
