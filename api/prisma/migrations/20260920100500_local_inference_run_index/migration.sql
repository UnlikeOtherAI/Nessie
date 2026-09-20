-- `runs` is large and remains live during ordinary rolling deploys. Keep this
-- as a one-statement migration so PostgreSQL can build it without a table-wide
-- write lock.
CREATE INDEX CONCURRENTLY "runs_local_inference_binding_idx"
  ON "runs"("local_inference_binding_id");
