-- Expand only: the audited backfill is deliberately a separate deployment.
-- `scripts/inspect-team-shape.sql` must produce a one-to-one, tenant-consistent
-- mapping before any existing row receives this value. Ambiguous and orphaned
-- projects halt that operation rather than being assigned by name or recency.
ALTER TABLE "projects" ADD COLUMN "team_id" UUID;

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "projects_team_id_idx" ON "projects"("team_id");
