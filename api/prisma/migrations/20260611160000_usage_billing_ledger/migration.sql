-- CreateEnum
CREATE TYPE "ConnectorType" AS ENUM ('mcp', 'http', 'web_search', 'web_fetch', 'storage', 'push', 'github', 'oauth', 'other');

-- AlterTable
ALTER TABLE "token_ledger_events" ADD COLUMN     "actor_type" "AuditActorType",
ADD COLUMN     "run_id" UUID;

-- CreateTable
CREATE TABLE "connector_usage_events" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID,
    "team_id" UUID,
    "channel_id" UUID,
    "thread_id" UUID,
    "task_id" UUID,
    "run_id" UUID,
    "agent_id" UUID,
    "actor_id" TEXT NOT NULL,
    "actor_type" "AuditActorType",
    "request_id" TEXT,
    "correlation_id" TEXT,
    "connector_type" "ConnectorType" NOT NULL,
    "connector_id" UUID,
    "target" TEXT,
    "operation" TEXT,
    "calls" INTEGER NOT NULL DEFAULT 1,
    "units" INTEGER,
    "unit_type" TEXT,
    "cost_amount" DECIMAL(20,8),
    "cost_currency" TEXT,
    "success" BOOLEAN,
    "latency_ms" INTEGER,
    "metadata" JSONB,

    CONSTRAINT "connector_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "token_ledger_events_organization_id_run_id_occurred_at_idx" ON "token_ledger_events"("organization_id", "run_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "connector_usage_events_org_occurred_at_idx" ON "connector_usage_events"("organization_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "connector_usage_events_org_connector_type_occurred_at_idx" ON "connector_usage_events"("organization_id", "connector_type", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "connector_usage_events_org_agent_id_occurred_at_idx" ON "connector_usage_events"("organization_id", "agent_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "connector_usage_events_org_channel_id_occurred_at_idx" ON "connector_usage_events"("organization_id", "channel_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "connector_usage_events_org_connector_id_occurred_at_idx" ON "connector_usage_events"("organization_id", "connector_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "connector_usage_events_org_run_id_occurred_at_idx" ON "connector_usage_events"("organization_id", "run_id", "occurred_at" DESC);
