-- CreateEnum
CREATE TYPE "KnowledgePageKind" AS ENUM ('document', 'file');

-- AlterTable: knowledge pages can now be file nodes
ALTER TABLE "knowledge_pages" ADD COLUMN "kind" "KnowledgePageKind" NOT NULL DEFAULT 'document';

-- AlterTable: a file-node version points at its stored object (app-enforced)
ALTER TABLE "knowledge_page_versions" ADD COLUMN "attachment_id" UUID;

-- CreateIndex
CREATE INDEX "knowledge_page_versions_attachment_id_idx" ON "knowledge_page_versions"("attachment_id");

-- AlterTable: 5 GB uploads overflow INT; widen to BIGINT. Add KB page link.
ALTER TABLE "attachments" ALTER COLUMN "size_bytes" SET DATA TYPE BIGINT;
ALTER TABLE "attachments" ADD COLUMN "knowledge_page_id" UUID;

-- CreateIndex
CREATE INDEX "attachments_knowledge_page_id_idx" ON "attachments"("knowledge_page_id");

-- AlterTable: per-scope storage quota
ALTER TABLE "budgets" ADD COLUMN "storage_limit_bytes" BIGINT;

-- CreateTable: append-only signed-delta stored-bytes ledger
CREATE TABLE "storage_usage_events" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID,
    "team_id" UUID,
    "space_id" UUID,
    "uploader_id" UUID,
    "attachment_id" UUID,
    "delta_bytes" BIGINT NOT NULL,
    "operation" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_type" "AuditActorType",
    "request_id" TEXT,
    "correlation_id" TEXT,
    "metadata" JSONB,

    CONSTRAINT "storage_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "storage_usage_events_organization_id_occurred_at_idx" ON "storage_usage_events"("organization_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "storage_usage_events_organization_id_project_id_idx" ON "storage_usage_events"("organization_id", "project_id");

-- CreateIndex
CREATE INDEX "storage_usage_events_organization_id_team_id_idx" ON "storage_usage_events"("organization_id", "team_id");

-- CreateIndex
CREATE INDEX "storage_usage_events_organization_id_space_id_idx" ON "storage_usage_events"("organization_id", "space_id");

-- CreateIndex
CREATE INDEX "storage_usage_events_organization_id_uploader_id_idx" ON "storage_usage_events"("organization_id", "uploader_id");

-- Backfill: seed a +size_bytes "store" event for every existing attachment so
-- current usage (SUM of deltas) starts accurate.
INSERT INTO "storage_usage_events" (
    "id", "occurred_at", "organization_id", "uploader_id", "attachment_id",
    "delta_bytes", "operation", "actor_id", "actor_type"
)
SELECT
    gen_random_uuid(),
    "created_at",
    "organization_id",
    "uploader_id",
    "id",
    "size_bytes",
    'store',
    COALESCE("uploader_id"::text, 'system'),
    'system'::"AuditActorType"
FROM "attachments";
