CREATE TYPE "ProductIntegrationRunStatus" AS ENUM (
  'queued',
  'running',
  'needs_setup',
  'completed',
  'failed',
  'warning'
);

CREATE TABLE "product_integration_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "product_slug" TEXT NOT NULL,
  "requested_by_user_id" UUID,
  "connector_id" UUID,
  "channel_id" UUID,
  "thread_id" UUID,
  "message_id" UUID,
  "external_run_id" TEXT,
  "status" "ProductIntegrationRunStatus" NOT NULL DEFAULT 'queued',
  "title" TEXT,
  "query_preview" TEXT NOT NULL DEFAULT '',
  "input_json" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "result_json" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "cost_amount" DECIMAL(18, 6),
  "cost_currency" TEXT,
  "source_count" INTEGER,
  "knowledge_page_id" UUID,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "product_integration_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "product_integration_runs_scope_requested_idx"
  ON "product_integration_runs"("organization_id", "team_id", "product_slug", "requested_at" DESC);

CREATE INDEX "product_integration_runs_status_idx"
  ON "product_integration_runs"("organization_id", "product_slug", "status");

CREATE INDEX "product_integration_runs_connector_idx"
  ON "product_integration_runs"("connector_id", "requested_at" DESC);

CREATE INDEX "product_integration_runs_message_idx"
  ON "product_integration_runs"("message_id");

CREATE INDEX "product_integration_runs_knowledge_page_idx"
  ON "product_integration_runs"("knowledge_page_id");

CREATE UNIQUE INDEX "product_integration_runs_org_product_external_run_key"
  ON "product_integration_runs"("organization_id", "product_slug", "external_run_id")
  WHERE "external_run_id" IS NOT NULL;

ALTER TABLE "product_integration_runs"
  ADD CONSTRAINT "product_integration_runs_organization_id_fkey"
  FOREIGN KEY ("organization_id")
  REFERENCES "organizations"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "product_integration_runs"
  ADD CONSTRAINT "product_integration_runs_team_id_fkey"
  FOREIGN KEY ("team_id")
  REFERENCES "teams"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "product_integration_runs"
  ADD CONSTRAINT "product_integration_runs_product_slug_fkey"
  FOREIGN KEY ("product_slug")
  REFERENCES "integrated_products"("slug")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "product_integration_runs"
  ADD CONSTRAINT "product_integration_runs_requested_by_user_id_fkey"
  FOREIGN KEY ("requested_by_user_id")
  REFERENCES "users"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "product_integration_runs"
  ADD CONSTRAINT "product_integration_runs_connector_id_fkey"
  FOREIGN KEY ("connector_id")
  REFERENCES "mcp_server_instances"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "product_integration_runs"
  ADD CONSTRAINT "product_integration_runs_channel_id_fkey"
  FOREIGN KEY ("channel_id")
  REFERENCES "channels"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "product_integration_runs"
  ADD CONSTRAINT "product_integration_runs_thread_id_fkey"
  FOREIGN KEY ("thread_id")
  REFERENCES "threads"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "product_integration_runs"
  ADD CONSTRAINT "product_integration_runs_message_id_fkey"
  FOREIGN KEY ("message_id")
  REFERENCES "messages"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "product_integration_runs"
  ADD CONSTRAINT "product_integration_runs_knowledge_page_id_fkey"
  FOREIGN KEY ("knowledge_page_id")
  REFERENCES "knowledge_pages"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
