-- Locally materialized data is deliberately a first-class source rather than
-- a loopback HTTP adapter. The immutable material row records its provenance
-- and access basis; the normalized bytes remain an ordinary dashboard dataset.
ALTER TYPE "DashboardSourceKind" ADD VALUE IF NOT EXISTS 'static';

ALTER TABLE "dashboard_data_sources"
  ALTER COLUMN "origin" DROP NOT NULL,
  ALTER COLUMN "path" DROP NOT NULL,
  ALTER COLUMN "transform" DROP NOT NULL;

ALTER TABLE "dashboards"
  ADD COLUMN "presentation" JSONB NOT NULL DEFAULT '{"filters":[],"insights":[],"attributions":[],"style":"standard"}';

ALTER TABLE "dashboard_versions"
  ADD COLUMN "presentation" JSONB NOT NULL DEFAULT '{"filters":[],"insights":[],"attributions":[],"style":"standard"}';

CREATE TABLE "dashboard_source_materials" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "source_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "source_reference" TEXT,
  "canonical_url" TEXT,
  "content_digest" TEXT NOT NULL,
  "original_attachment_id" UUID,
  "parser" TEXT NOT NULL,
  "parser_version" INTEGER NOT NULL DEFAULT 1,
  "provenance" JSONB NOT NULL,
  "access_basis" JSONB NOT NULL DEFAULT '[]',
  "normalization_losses" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dashboard_source_materials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dashboard_source_materials_source_id_key" UNIQUE ("source_id"),
  CONSTRAINT "dashboard_source_materials_source_id_fkey"
    FOREIGN KEY ("source_id") REFERENCES "dashboard_data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "dashboard_source_materials_organization_id_source_id_idx"
  ON "dashboard_source_materials"("organization_id", "source_id");

CREATE TABLE "dashboard_deltas" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "dashboard_id" UUID NOT NULL,
  "mutation_id" UUID NOT NULL,
  "base_revision" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL,
  "operations" JSONB NOT NULL,
  "author_type" "DashboardAuthorType" NOT NULL,
  "author_id" UUID NOT NULL,
  "run_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dashboard_deltas_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dashboard_deltas_dashboard_id_mutation_id_key" UNIQUE ("dashboard_id", "mutation_id"),
  CONSTRAINT "dashboard_deltas_dashboard_id_revision_key" UNIQUE ("dashboard_id", "revision"),
  CONSTRAINT "dashboard_deltas_dashboard_id_fkey"
    FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "dashboard_deltas_organization_id_dashboard_id_created_at_idx"
  ON "dashboard_deltas"("organization_id", "dashboard_id", "created_at" DESC);
