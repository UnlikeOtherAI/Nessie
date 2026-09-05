-- Boards become saved views over a project's task pool.
--
-- Before: one board per project, stored as `projects.board_style` plus a flat
-- `board_columns.project_id` list, with the placement pinned on
-- `tasks.column_id` / `tasks.position`.
--
-- After: `boards` owns the style, the columns and a filter; a task's placement
-- on a given board is a `task_board_placements` row. `tasks.status` stays the
-- one lifecycle truth the worker drives.

-- 1. The board table, and one default board per existing project carrying that
--    project's current style.
CREATE TABLE "boards" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "style" "BoardStyle" NOT NULL DEFAULT 'kanban',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,
    "filter" JSONB NOT NULL DEFAULT '{}',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "boards_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "boards_project_id_position_idx" ON "boards"("project_id", "position");

ALTER TABLE "boards" ADD CONSTRAINT "boards_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "boards" ADD CONSTRAINT "boards_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "boards" ("id", "project_id", "organization_id", "name", "style", "is_default", "position", "updated_at")
SELECT gen_random_uuid(), p."id", p."organization_id", 'Board', p."board_style", true, 0, CURRENT_TIMESTAMP
  FROM "projects" p;

-- 2. Columns hang off the board, not the project, and can bind external states.
ALTER TABLE "board_columns" ADD COLUMN "board_id" UUID;
ALTER TABLE "board_columns" ADD COLUMN "state_bindings" JSONB NOT NULL DEFAULT '[]';

UPDATE "board_columns" c
   SET "board_id" = b."id"
  FROM "boards" b
 WHERE b."project_id" = c."project_id" AND b."is_default";

-- A column whose project vanished under it has nothing to belong to; the FK
-- below would refuse it, so it goes with the project it was already orphaned by.
DELETE FROM "board_columns" WHERE "board_id" IS NULL;

ALTER TABLE "board_columns" ALTER COLUMN "board_id" SET NOT NULL;

DROP INDEX "board_columns_project_id_position_idx";
ALTER TABLE "board_columns" DROP CONSTRAINT "board_columns_project_id_fkey";
ALTER TABLE "board_columns" DROP COLUMN "project_id";

CREATE INDEX "board_columns_board_id_position_idx" ON "board_columns"("board_id", "position");
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_board_id_fkey"
    FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Placements: one row per (task, board) somebody explicitly placed. Seeded
--    from the column's own board rather than the task's project, so a
--    historically inconsistent (task, column) pair cannot violate the FK.
CREATE TABLE "task_board_placements" (
    "task_id" UUID NOT NULL,
    "board_id" UUID NOT NULL,
    "column_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_board_placements_pkey" PRIMARY KEY ("task_id", "board_id")
);

CREATE INDEX "task_board_placements_column_id_position_idx" ON "task_board_placements"("column_id", "position");

ALTER TABLE "task_board_placements" ADD CONSTRAINT "task_board_placements_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_board_placements" ADD CONSTRAINT "task_board_placements_board_id_fkey"
    FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_board_placements" ADD CONSTRAINT "task_board_placements_column_id_fkey"
    FOREIGN KEY ("column_id") REFERENCES "board_columns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "task_board_placements" ("task_id", "board_id", "column_id", "position", "updated_at")
SELECT t."id", c."board_id", c."id", t."position", CURRENT_TIMESTAMP
  FROM "tasks" t
  JOIN "board_columns" c ON c."id" = t."column_id"
 WHERE t."column_id" IS NOT NULL;

-- 4. The pin leaves the task.
DROP INDEX "tasks_column_id_position_idx";
DROP INDEX "tasks_column_id_idx";
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_column_id_fkey";
ALTER TABLE "tasks" DROP COLUMN "column_id";
ALTER TABLE "tasks" DROP COLUMN "position";

-- 5. The style leaves the project.
ALTER TABLE "projects" DROP COLUMN "board_style";

-- 6. Exactly one default board per project.
CREATE UNIQUE INDEX "boards_one_default_per_project" ON "boards"("project_id") WHERE "is_default";
