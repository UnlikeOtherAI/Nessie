CREATE TABLE "product_team_enablements" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "product_slug" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "external_org_id" TEXT,
  "external_team_id" TEXT,
  "configured_by_user_id" UUID,
  "metadata_json" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "product_team_enablements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_team_enablements_organization_id_team_id_product_slug_key"
  ON "product_team_enablements"("organization_id", "team_id", "product_slug");

CREATE INDEX "product_team_enablements_product_slug_enabled_idx"
  ON "product_team_enablements"("product_slug", "enabled");

ALTER TABLE "product_team_enablements"
  ADD CONSTRAINT "product_team_enablements_organization_id_fkey"
  FOREIGN KEY ("organization_id")
  REFERENCES "organizations"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "product_team_enablements"
  ADD CONSTRAINT "product_team_enablements_team_id_fkey"
  FOREIGN KEY ("team_id")
  REFERENCES "teams"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "product_team_enablements"
  ADD CONSTRAINT "product_team_enablements_product_slug_fkey"
  FOREIGN KEY ("product_slug")
  REFERENCES "integrated_products"("slug")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "product_team_enablements"
  ADD CONSTRAINT "product_team_enablements_configured_by_user_id_fkey"
  FOREIGN KEY ("configured_by_user_id")
  REFERENCES "users"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
