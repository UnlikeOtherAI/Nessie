-- Scope tasks to a project (nullable: existing org-wide and agent-run tasks keep projectId NULL)
ALTER TABLE "tasks" ADD COLUMN "project_id" UUID;

-- Foreign key
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Index for per-project board queries
CREATE INDEX "tasks_organization_id_project_id_status_idx" ON "tasks"("organization_id", "project_id", "status");
