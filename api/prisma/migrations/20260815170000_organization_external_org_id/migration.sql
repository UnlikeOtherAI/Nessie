-- Organizations map 1:1 to UnlikeOtherAI organisations. `external_org_id` is
-- the stable UOA organisation id; NULL marks a local-mode organization
-- (bootstrap / no-SSO installs). Column + unique index only — the data
-- partition of existing shared-org tenants is the follow-up migration
-- `20260815180000_partition_uoa_organizations`.
ALTER TABLE "organizations" ADD COLUMN "external_org_id" TEXT;

CREATE UNIQUE INDEX "organizations_external_org_id_key"
  ON "organizations"("external_org_id");
