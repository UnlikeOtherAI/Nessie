-- UOA is the sole customer-commercial authority. DeepWater's Ledger MCP
-- contract no longer returns a cost, and Nessie must retain only operational
-- run/call/source telemetry. Preserve a cost-free boolean for conservative
-- handoff recovery, then erase every historical local amount and currency.

UPDATE "product_integration_runs"
SET
  "result_json" = COALESCE("result_json", '{}'::jsonb)
    || jsonb_build_object('legacyDispatchEvidence', true),
  "cost_amount" = NULL,
  "cost_currency" = NULL,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "product_slug" = 'deep-water'
  AND ("cost_amount" IS NOT NULL OR "cost_currency" IS NOT NULL);

-- These columns were introduced for the DeepWater mirror and had no other
-- writer. Removing them keeps the physical schema aligned with Prisma and
-- makes Product-run commercial persistence structurally impossible.
ALTER TABLE "product_integration_runs"
  DROP COLUMN "cost_amount",
  DROP COLUMN "cost_currency";

UPDATE "connector_usage_events"
SET
  "cost_amount" = NULL,
  "cost_currency" = NULL
WHERE "target" = 'deep-water'
  OR "metadata" ->> 'productSlug' = 'deep-water'
  OR "metadata" ->> 'product_slug' = 'deep-water'
  OR "metadata" ->> 'product' = 'deep-water'
  OR "metadata" ->> 'source' = 'deep_water_run_update';

UPDATE "integrated_products"
SET
  "summary" = 'Ledger-metered Deep Water research jobs, sources, and reports. Customer totals come only from UOA.',
  "capabilities" = ARRAY['deep_research', 'sources', 'raw_usage', 'knowledge_import']::TEXT[],
  "setup_hint" = 'Enable Deep Water after configuring Nessie''s dedicated Ledger app API key. Signed SSO identity attributes raw usage to its user, organization, and team; UOA supplies customer totals.',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'deep-water';

CREATE OR REPLACE FUNCTION "nessie_reject_deepwater_usage_cost"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW."target" = 'deep-water'
    OR NEW."metadata" ->> 'productSlug' = 'deep-water'
    OR NEW."metadata" ->> 'product_slug' = 'deep-water'
    OR NEW."metadata" ->> 'product' = 'deep-water'
    OR NEW."metadata" ->> 'source' = 'deep_water_run_update'
  ) AND (NEW."cost_amount" IS NOT NULL OR NEW."cost_currency" IS NOT NULL) THEN
    RAISE EXCEPTION 'DeepWater connector cost persistence is forbidden; UOA is authoritative'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "connector_usage_events_deepwater_cost_boundary"
  ON "connector_usage_events";
CREATE TRIGGER "connector_usage_events_deepwater_cost_boundary"
BEFORE INSERT OR UPDATE ON "connector_usage_events"
FOR EACH ROW
EXECUTE FUNCTION "nessie_reject_deepwater_usage_cost"();
