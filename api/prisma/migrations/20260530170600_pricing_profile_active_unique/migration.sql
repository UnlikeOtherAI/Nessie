-- Make the active-pricing-profile lookup deterministic. findPricingProfile
-- (worker) selects the live profile for (organization_id, provider, model) where
-- effective_to IS NULL, ordered only by model_pattern; if two active rows shared
-- the same (organization_id, provider, model_pattern) the winner was arbitrary.
-- A partial unique index guarantees at most one active row per pattern, so the
-- lookup result is stable.
--
-- Prisma cannot express partial unique indexes, so this is raw SQL; the schema
-- carries a documenting comment on ModelPricingProfile.
--
-- ORPHAN/CONFLICT GUARD: before applying, verify there are no existing duplicate
-- active rows:
--   SELECT organization_id, provider, model_pattern, count(*)
--   FROM model_pricing_profiles WHERE effective_to IS NULL
--   GROUP BY 1,2,3 HAVING count(*) > 1;
-- Any group with count > 1 must be reconciled (retire the stale rows by setting
-- effective_to) before this index can be created.
--
-- PRODUCTION: use CREATE UNIQUE INDEX CONCURRENTLY here (cannot run inside
-- Prisma's migration transaction). Flagged for the deploy runbook.
CREATE UNIQUE INDEX "model_pricing_profiles_active_unique"
  ON "model_pricing_profiles" ("organization_id", "provider", "model_pattern")
  WHERE "effective_to" IS NULL;
