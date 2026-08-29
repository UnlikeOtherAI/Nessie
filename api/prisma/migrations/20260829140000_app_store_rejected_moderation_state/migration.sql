-- Retire the legacy `rejected` rows that the App Store still lists to their owner.
--
-- `20260829090000_mcp_app_store_catalogue` backfilled `moderation_state` from
-- the lifecycle a row already had, mapping `deprecated` → `hidden` but
-- everything else → `curated`. A connector that had ALREADY been rejected by a
-- reviewer therefore carries `curated`, and the store's curation rule admits a
-- curated row to its own owner — so a rejected connector keeps rendering as a
-- normal app card to the person whose submission was turned down.
--
-- The write paths are fixed in code from here on (`rejectSubmission` and
-- `deprecateCatalogEntry` now record `hidden` themselves). This closes the
-- residue that predates them.
--
-- Deliberately narrow: only rows still sitting on the backfill's default. A
-- `moderation_state` that is anything else was set by a human or by the new
-- code, and is not ours to overwrite.
UPDATE "mcp_catalog_entries"
SET "moderation_state" = 'hidden'
WHERE "status" = 'rejected'
  AND "moderation_state" = 'curated';
