-- A channel can be organization-wide without pretending to be a UOA workspace.
-- The hidden root keeps the existing project/team foreign-key model intact while
-- making its purpose explicit and allowing one #general here plus one in every
-- real project.
ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "channel_root" BOOLEAN NOT NULL DEFAULT false;

-- Preserve the existing local-mode standalone channel container.
UPDATE "projects"
SET "channel_root" = true
WHERE "id" = '00000000-0000-4000-8000-000000000002'::uuid;

CREATE UNIQUE INDEX IF NOT EXISTS "projects_organization_channel_root_key"
  ON "projects"("organization_id")
  WHERE "channel_root" = true;
