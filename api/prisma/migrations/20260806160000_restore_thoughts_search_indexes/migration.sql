-- Restore the memory full-text and metadata GIN indexes.
--
-- `20260408140200_memory_vector_columns_and_search` created
-- `idx_thoughts_search_vector` and `idx_thoughts_metadata`, and
-- `20260516202000_reconcile_drift` dropped both. Nothing recreated them, but the
-- queries that need them are still there: `match_thoughts_lexical` and
-- `match_thoughts_hybrid` both filter on `t.search_vector @@ ts_query` and rank
-- with `ts_rank_cd(t.search_vector, ...)`. Without the GIN index every memory
-- recall sequentially scans `thoughts` and recomputes the rank per row.
--
-- Neither index is expressible in schema.prisma (a GIN index over a tsvector /
-- jsonb column), which is why the drift reconciliation dropped them rather than
-- reconciling them. `prisma migrate diff` may keep reporting them as drift for
-- the same reason — that is a Prisma limitation, not a stale index. Do not let
-- a future reconciliation drop them again.
--
-- IF NOT EXISTS keeps this idempotent on databases that still have them.

CREATE INDEX IF NOT EXISTS idx_thoughts_search_vector
  ON thoughts USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS idx_thoughts_metadata
  ON thoughts USING GIN (metadata);
