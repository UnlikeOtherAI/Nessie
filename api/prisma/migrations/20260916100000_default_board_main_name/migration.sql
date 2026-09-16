-- A project's first board is created as "Main board" rather than "Board"
-- (`DEFAULT_BOARD_NAME`), so its sidebar row does not read as a second copy of
-- the "Boards" section it sits under.
--
-- Rename the boards that still carry the old default. Only a default board
-- whose name is exactly the old constant is touched, so a board a person named
-- keeps its name — including one they deliberately called "Board".
UPDATE "boards" SET "name" = 'Main board' WHERE "name" = 'Board' AND "is_default" = true;
