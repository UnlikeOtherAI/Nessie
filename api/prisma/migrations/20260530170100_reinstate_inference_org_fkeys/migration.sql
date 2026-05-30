-- Re-add the organization_id foreign keys on the 8 inference control-plane
-- tables. These FKs were dropped by 20260516202000_reconcile_drift and never
-- restored, leaving organization_id as an unenforced UUID on every inference
-- table. Re-adding them with ON DELETE CASCADE means deleting an organization
-- correctly tears down its inference configuration.
--
-- ORPHAN-CLEANUP GUARD: before applying, the deploy runner MUST verify there
-- are no rows whose organization_id has no matching organizations.id, e.g.:
--   SELECT 'inference_providers' AS tbl, count(*) FROM inference_providers p
--     LEFT JOIN organizations o ON o.id = p.organization_id WHERE o.id IS NULL
--   UNION ALL ... (repeat for the other 7 tables).
-- Any non-zero count must be reconciled (deleted or reparented) before this
-- migration runs, or the ADD CONSTRAINT will fail.

ALTER TABLE "inference_providers"
  ADD CONSTRAINT "inference_providers_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inference_models"
  ADD CONSTRAINT "inference_models_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inference_credential_bindings"
  ADD CONSTRAINT "inference_credential_bindings_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inference_capability_overrides"
  ADD CONSTRAINT "inference_capability_overrides_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inference_routing_profiles"
  ADD CONSTRAINT "inference_routing_profiles_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inference_eval_suites"
  ADD CONSTRAINT "inference_eval_suites_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inference_eval_runs"
  ADD CONSTRAINT "inference_eval_runs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tool_mediator_profiles"
  ADD CONSTRAINT "tool_mediator_profiles_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
