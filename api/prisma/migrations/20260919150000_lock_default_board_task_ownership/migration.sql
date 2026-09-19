-- A NULL task.board_id means the project's default board at the instant the
-- write commits. Serialize those writes with default-board replacement so a
-- task cannot cross audiences between the materialization update and the
-- default flip. The project row is the shared lock for every current and
-- future task writer, including direct Prisma writes in the API and worker.
CREATE FUNCTION "lock_default_board_task_ownership"()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM 1
  FROM "projects"
  WHERE "id" = NEW."project_id"
  FOR UPDATE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tasks_lock_default_board_ownership_trg"
BEFORE INSERT OR UPDATE OF "project_id", "board_id" ON "tasks"
FOR EACH ROW
WHEN (NEW."project_id" IS NOT NULL AND NEW."board_id" IS NULL)
EXECUTE FUNCTION "lock_default_board_task_ownership"();
