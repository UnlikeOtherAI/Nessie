-- Durable project attention: one immutable user-alert generation per source
-- event, plus exact project identities for foreground push suppression.

ALTER TYPE "UserAlertKind" ADD VALUE IF NOT EXISTS 'task_assigned';
ALTER TYPE "UserAlertKind" ADD VALUE IF NOT EXISTS 'knowledge_published';

ALTER TYPE "PushSurfaceKind" ADD VALUE IF NOT EXISTS 'project_board';
ALTER TYPE "PushSurfaceKind" ADD VALUE IF NOT EXISTS 'knowledge_space';

ALTER TABLE "user_alerts"
  ADD COLUMN "project_id" UUID,
  ADD COLUMN "task_id" UUID,
  ADD COLUMN "knowledge_page_id" UUID,
  ADD COLUMN "event_key" TEXT;

ALTER TABLE "user_alerts"
  ADD CONSTRAINT "user_alerts_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "user_alerts_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "user_alerts_knowledge_page_id_fkey"
  FOREIGN KEY ("knowledge_page_id") REFERENCES "knowledge_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "user_alerts_user_id_kind_project_id_read_at_created_at_idx"
  ON "user_alerts"("user_id", "kind", "project_id", "read_at", "created_at");
CREATE UNIQUE INDEX "user_alerts_user_id_event_key_key"
  ON "user_alerts"("user_id", "event_key");

ALTER TABLE "user_push_surface_presence"
  ADD COLUMN "project_id" UUID,
  ADD COLUMN "knowledge_space_id" UUID;

ALTER TABLE "user_push_surface_presence"
  ADD CONSTRAINT "user_push_surface_presence_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "user_push_surface_presence_knowledge_space_id_fkey"
  FOREIGN KEY ("knowledge_space_id") REFERENCES "knowledge_spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER INDEX "user_push_surface_presence_organization_id_user_id_surface_kind"
  RENAME TO "idx_push_presence_channel";

CREATE INDEX "idx_push_presence_project"
  ON "user_push_surface_presence"("organization_id", "user_id", "surface_kind", "project_id", "last_seen_at");
CREATE INDEX "idx_push_presence_knowledge_space"
  ON "user_push_surface_presence"("organization_id", "user_id", "surface_kind", "knowledge_space_id", "last_seen_at");
