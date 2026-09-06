-- Horizontal scaling, invariant 2 (docs/standards/horizontal-scaling.md):
-- leaderless sweeps gain a cluster-wide claim.
--
-- 1. `realtime_prune_state` is the shared clock for the `realtime_events`
--    retention sweep (audit 2.3). The cadence used to be an in-process
--    `lastPruneAt`, so every replica pruned once a minute; `realtime_events`
--    has no index on `created_at` alone, which makes each of those a
--    sequential scan. One tenant-free row, because the sweep deletes across
--    every organisation.
-- 2. `deleting` lets the tombstoned-browser reconciler claim a row before it
--    calls Browserbase (audit 5.10), instead of read-then-delete where every
--    loser wrote a spurious `last_error`.

CREATE TABLE "realtime_prune_state" (
    "id" TEXT NOT NULL,
    "pruned_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "realtime_prune_state_pkey" PRIMARY KEY ("id")
);

ALTER TYPE "AgentBrowserStatus" ADD VALUE 'deleting';
