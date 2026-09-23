-- DeepWater research events (Water plan amendments-streaming S2): DeepWater
-- pushes a research's progress, settled planner turns and outcome straight to
-- Nessie's signed receiver, and the watch through Ledger becomes the backstop.
--
--   last_event_at  when DeepWater's last research event for this run was
--                  received. While it is under two minutes old the watch reads
--                  the run at most every 60 s instead of every 5 or 30 s,
--                  because each event already makes the worker read it at once.
--                  NULL until the first event, and for every run the push never
--                  reaches (the push is off, or a launcher run).
--
-- The latest progress snapshot itself lives in `scope_json.progress`, beside
-- the brief registers it is shown with.
--
-- Additive and NULL, so the previous build keeps writing rows.
ALTER TABLE "product_integration_runs"
  ADD COLUMN "last_event_at" TIMESTAMP(3);
