-- Per-project board style + custom columns
CREATE TYPE "BoardStyle" AS ENUM ('kanban', 'scrum');
CREATE TYPE "ColumnCategory" AS ENUM ('todo', 'in_progress', 'review', 'done');

ALTER TABLE "projects" ADD COLUMN "board_style" "BoardStyle" NOT NULL DEFAULT 'kanban';

CREATE TABLE "board_columns" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ColumnCategory" NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "board_columns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "board_columns_project_id_position_idx" ON "board_columns"("project_id", "position");
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Task placement override: which column a card is pinned to (null = auto-place by status)
ALTER TABLE "tasks" ADD COLUMN "column_id" UUID;
CREATE INDEX "tasks_column_id_idx" ON "tasks"("column_id");
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_column_id_fkey"
  FOREIGN KEY ("column_id") REFERENCES "board_columns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the 4 default columns for every existing project
INSERT INTO "board_columns" ("id", "project_id", "organization_id", "name", "category", "position", "created_at", "updated_at")
SELECT gen_random_uuid(), p."id", p."organization_id", c.name, c.category::"ColumnCategory", c.position, NOW(), NOW()
FROM "projects" p
CROSS JOIN (VALUES
  ('To do', 'todo', 0),
  ('In progress', 'in_progress', 1),
  ('Review', 'review', 2),
  ('Done', 'done', 3)
) AS c(name, category, position);
