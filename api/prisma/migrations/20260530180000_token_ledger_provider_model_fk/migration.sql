-- Add nullable provider_id / model_id FK columns to the token ledger. The
-- denormalized provider/model strings stay as the durable record (so a deleted
-- provider/model never corrupts an immutable ledger row); the ids are added for
-- fast joins to the inference catalog. onDelete: SetNull preserves the row.
ALTER TABLE "token_ledger_events" ADD COLUMN "provider_id" UUID;
ALTER TABLE "token_ledger_events" ADD COLUMN "model_id" UUID;

-- Backfill historical rows from the denormalized strings. provider (the stored
-- value) is the provider_key; model is the resolved model name.
UPDATE "token_ledger_events" e
SET "provider_id" = p."id"
FROM "inference_providers" p
WHERE p."organization_id" = e."organization_id"
  AND p."provider_key" = e."provider"
  AND e."provider_id" IS NULL;

UPDATE "token_ledger_events" e
SET "model_id" = m."id"
FROM "inference_models" m
WHERE m."organization_id" = e."organization_id"
  AND m."provider_id" = e."provider_id"
  AND m."model" = e."model"
  AND e."model_id" IS NULL;

ALTER TABLE "token_ledger_events"
  ADD CONSTRAINT "token_ledger_events_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "inference_providers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "token_ledger_events"
  ADD CONSTRAINT "token_ledger_events_model_id_fkey"
  FOREIGN KEY ("model_id") REFERENCES "inference_models"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
