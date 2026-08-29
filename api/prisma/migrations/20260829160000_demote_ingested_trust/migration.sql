-- Demote any registry-ingested app that was granted a "Verified" badge.
--
-- The first ingestion mapper decided trust from the advertised endpoint alone,
-- matching it against Nessie's curated library. The record author chooses that
-- URL, so publishing `io.github.attacker/notion-official` pointing at Notion's
-- real endpoint minted a store card carrying the attacker's own title and
-- description under a badge reading "Reviewed by Nessie and confirmed with its
-- publisher".
--
-- Ingestion now always writes `community` and `verified` is a human judgement
-- again. This clears rows written before that change, in any store where a
-- sweep already ran.
--
-- Narrow on purpose: only registry-sourced rows. A `verified` row a curator set
-- by hand, and the first-party `nessie` rows, are untouched.
UPDATE "mcp_catalog_entries"
SET "trust_level" = 'community'
WHERE "app_source" = 'mcp_registry'
  AND "trust_level" = 'verified';
