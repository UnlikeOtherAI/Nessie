-- Make the upstream registry id the database-arbitrated identity of an
-- ingested app.
--
-- Registry ingestion upserts on `registry_name`, and until now that column had
-- neither an index nor a constraint. Two consequences, both real:
--
--  - Every record in a sweep did a sequential scan to find its own row. At
--    ~2,000 rows that is 2,000 scans per sweep, growing quadratically as the
--    catalogue fills.
--  - Nothing stopped two sweeps racing. An owner triggering the route while
--    the CLI is already walking (or a second run after the in-process guard's
--    stale window lapses) has both processes look up the same `registry_name`,
--    both find nothing, and both insert — and because the name/slug resolvers
--    append a suffix on collision, the second insert SUCCEEDS. The store then
--    holds two cards for one server permanently, and later sweeps update
--    whichever row the lookup happens to return.
--
-- Partial, because `registry_name` is null for every hand-authored connector
-- and those must stay unconstrained.
--
-- Non-concurrent by necessity: Prisma runs each migration in a transaction and
-- `CREATE INDEX CONCURRENTLY` cannot run inside one. This table holds
-- connector definitions (dozens to a few thousand rows), not a hot append-only
-- table, and `lint:migrations` accordingly does not list it among the tables it
-- guards.
--
-- Deduplicate first: a unique index cannot be created over existing duplicates,
-- and a migration that fails on real data is worse than one that repairs it.
-- Keep the oldest row for each registry_name — it is the one earlier sweeps
-- have been updating and the one any curator edits landed on.
UPDATE "mcp_catalog_entries" AS e
SET "registry_name" = NULL
WHERE e."registry_name" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "mcp_catalog_entries" AS other
    WHERE other."registry_name" = e."registry_name"
      AND (other."created_at", other."id") < (e."created_at", e."id")
  );

CREATE UNIQUE INDEX "mcp_catalog_entries_registry_name_key"
  ON "mcp_catalog_entries" ("registry_name")
  WHERE "registry_name" IS NOT NULL;
