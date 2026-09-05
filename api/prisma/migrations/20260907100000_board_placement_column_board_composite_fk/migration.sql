-- Referential integrity for board placements: a placement's column must belong
-- to the placement's board.
--
-- `task_board_placements` carried task_id, board_id and column_id as three
-- independent foreign keys, so nothing at the storage layer stopped a row
-- pointing a task at a column of a *different* board. The single writer today
-- (packages/team-admin/src/project-task-move.ts) resolves the column with its
-- board included and cannot produce a bad row; a second writer would not be
-- stopped. This is the technique the schema already uses two models away for
-- Agent.ownerMembership: express the pair as one composite foreign key.

-- 1. The pair the placement points at.
ALTER TABLE "board_columns"
    ADD CONSTRAINT "board_columns_id_board_id_key" UNIQUE ("id", "board_id");

-- 2. Any pre-existing inconsistent placement would fail step 3. There are none
--    (the seed in 20260906100000_project_boards took board_id FROM the column),
--    but a row written by hand since would silently block the deploy, so repair
--    it to the column's own board first: the column is the specific fact, the
--    board is derivable from it.
UPDATE "task_board_placements" p
   SET "board_id" = c."board_id"
  FROM "board_columns" c
 WHERE c."id" = p."column_id"
   AND c."board_id" <> p."board_id"
   -- Only when the repair does not collide with a placement that already
   -- exists for (task, correct board); those are dropped below instead.
   AND NOT EXISTS (
     SELECT 1 FROM "task_board_placements" q
      WHERE q."task_id" = p."task_id" AND q."board_id" = c."board_id"
   );

DELETE FROM "task_board_placements" p
 USING "board_columns" c
 WHERE c."id" = p."column_id"
   AND c."board_id" <> p."board_id";

-- 3. Re-point the column foreign key at the pair.
ALTER TABLE "task_board_placements"
    DROP CONSTRAINT "task_board_placements_column_id_fkey";
ALTER TABLE "task_board_placements"
    ADD CONSTRAINT "task_board_placements_column_id_board_id_fkey"
    FOREIGN KEY ("column_id", "board_id") REFERENCES "board_columns"("id", "board_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
