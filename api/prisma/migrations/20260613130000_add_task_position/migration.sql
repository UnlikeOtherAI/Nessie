-- Per-column manual ordering for kanban cards.
ALTER TABLE "tasks" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "tasks_column_id_position_idx" ON "tasks"("column_id", "position");
