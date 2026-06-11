-- Scrum iterations (sprints)
CREATE TYPE "IterationStatus" AS ENUM ('planned', 'active', 'completed');

CREATE TABLE "iterations" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "goal" TEXT,
    "status" "IterationStatus" NOT NULL DEFAULT 'planned',
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "capacity" INTEGER,
    "position" INTEGER NOT NULL,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "iterations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "iterations_project_id_position_idx" ON "iterations"("project_id", "position");
CREATE INDEX "iterations_project_id_status_idx" ON "iterations"("project_id", "status");
ALTER TABLE "iterations" ADD CONSTRAINT "iterations_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Task sprint assignment + estimate
ALTER TABLE "tasks" ADD COLUMN "iteration_id" UUID;
ALTER TABLE "tasks" ADD COLUMN "story_points" INTEGER;
CREATE INDEX "tasks_iteration_id_idx" ON "tasks"("iteration_id");
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_iteration_id_fkey"
  FOREIGN KEY ("iteration_id") REFERENCES "iterations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
