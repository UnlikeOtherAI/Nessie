ALTER TABLE "teams"
  ADD COLUMN IF NOT EXISTS "system_managed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "metadata" JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS "teams_project_id_system_managed_idx"
  ON "teams"("project_id", "system_managed");
