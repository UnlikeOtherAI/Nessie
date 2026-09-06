-- A board owns its tasks.
--
-- Boards used to be N saved views over one project task pool, so every board of
-- a project rendered the same cards. `board_id` makes a task live on exactly one
-- board; NULL means the project's default board, which is both what every
-- pre-existing row means and what the task-creating call sites that know nothing
-- about boards (agent runs, triggers, mailbox, external source sync) keep
-- producing. No backfill is needed: NULL already reads as "the default board",
-- which is exactly where these tasks rendered before.
--
-- ON DELETE SET NULL, not CASCADE: deleting a board has never deleted work, and
-- must not start now — its tasks return to the project's default board.
ALTER TABLE "tasks" ADD COLUMN "board_id" UUID;

ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_board_id_fkey"
  FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "tasks_board_id_idx" ON "tasks"("board_id");
