-- Task #42: tool-registry spec follow-ups (review of #10, §3.1 reconcile).
--
-- 1. `overview` is treated by spec §3.1 as a required human-readable summary.
--    Drop the column default so new inserts must supply a non-empty value.
--    The column stays NOT NULL; pre-reconcile rows backfilled with `''`
--    remain legal at the DB level, but step 2 upgrades them where possible.
--
-- 2. Backfill `overview` from `description` for rows that still carry the
--    legacy empty-string placeholder. Runs after the DROP DEFAULT above so
--    the backfill is not fighting a column-level default.
--
-- Index/concurrency caveats from the #10 review are tracked in the plan
-- (deferred until Nessie carries live production load).

-- 1. Drop the column default. Existing rows keep whatever value they had.
ALTER TABLE "tool_registry_entries"
  ALTER COLUMN "overview" DROP DEFAULT;

-- 2. Backfill legacy empty-string overviews from description, where available.
--    `description` is NOT NULL today, but the length() guard keeps the update
--    safe if a future migration ever relaxes that.
UPDATE "tool_registry_entries"
  SET "overview" = "description"
  WHERE "overview" = ''
    AND "description" IS NOT NULL
    AND length("description") > 0;
