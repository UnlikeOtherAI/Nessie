-- `thread_stream_events` joins the `realtime_events` retention sweep
-- (horizontal-scaling audit 2.3: it was never pruned at all), and that sweep's
-- DELETE selects on `created_at` alone.
--
-- `realtime_events` carries no such index and is accepted as a sequential scan,
-- because it is the smaller table and the sweep runs once a minute for the
-- whole cluster. This one is larger by orders of magnitude — a row per streamed
-- token — so the same cadence would not make the same scan acceptable here.
--
-- Inert to the build still serving while this runs. Migrations are applied
-- before the blue-green swap, and an index changes no result, only the plan
-- that produces it; no column is added, so a replica that has never heard of
-- this migration reads and writes the table exactly as before.
CREATE INDEX IF NOT EXISTS "thread_stream_events_created_at_idx"
  ON "thread_stream_events" ("created_at");
