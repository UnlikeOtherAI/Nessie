-- Add a nullable `last_error` column to `mcp_server_instances` so probe
-- failures surfaced by `testInstance` / `refreshInstance` can be rendered in
-- the admin UI alongside `lifecycle_state = 'error'` and
-- `health_failure_count`. Cleared on a successful probe.
--
-- Additive, nullable, no backfill required — existing rows simply get NULL
-- (= no recorded probe failure yet).

ALTER TABLE "mcp_server_instances"
  ADD COLUMN "last_error" TEXT;
