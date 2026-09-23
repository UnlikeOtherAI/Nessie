-- DeepWater research briefs: the two product-run statuses the brief lifecycle
-- adds.
--
--   drafting   the research brief is being agreed with DeepWater's planner;
--              it becomes `running` at launch. (`starting` is a view state
--              derived from the pending launch action, never a stored status.)
--   cancelled  a brief or a research the requester, an owner or DeepWater
--              cancelled, or an idle brief DeepWater expired.
--
-- They land in their own migration, before anything writes them, for two
-- reasons. PostgreSQL refuses to use a new enum value inside the transaction
-- that adds it, and the next migration's partial index names 'drafting'. And a
-- replica still running the previous build never meets a status it cannot
-- parse, because only the brief API and worker (a later release) write them.
ALTER TYPE "ProductIntegrationRunStatus" ADD VALUE IF NOT EXISTS 'drafting';
ALTER TYPE "ProductIntegrationRunStatus" ADD VALUE IF NOT EXISTS 'cancelled';
