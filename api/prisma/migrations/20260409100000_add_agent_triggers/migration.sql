-- Add trigger enums
CREATE TYPE "AgentTriggerType" AS ENUM ('manual', 'scheduled', 'webhook', 'event', 'interval');
CREATE TYPE "AgentTriggerStatus" AS ENUM ('active', 'paused', 'error');
CREATE TYPE "AgentTriggerDeliveryStatus" AS ENUM ('pending', 'delivered', 'failed', 'skipped');

-- Add trigger columns to runs
ALTER TABLE "runs" ADD COLUMN "trigger_id" UUID;
ALTER TABLE "runs" ADD COLUMN "trigger_delivery_id" UUID;

-- Trigger definitions live independently from agents
CREATE TABLE "agent_triggers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" UUID NOT NULL,
    "type" "AgentTriggerType" NOT NULL,
    "status" "AgentTriggerStatus" NOT NULL DEFAULT 'active',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "name" TEXT,
    "description" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "last_fired_at" TIMESTAMP(3),
    "next_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_triggers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_triggers_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Trigger deliveries capture inbound payloads and execution outcomes
CREATE TABLE "agent_trigger_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trigger_id" UUID NOT NULL,
    "status" "AgentTriggerDeliveryStatus" NOT NULL DEFAULT 'pending',
    "source" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_trigger_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_trigger_deliveries_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "agent_triggers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "agent_triggers_agent_id_created_at_idx" ON "agent_triggers"("agent_id", "created_at");
CREATE INDEX "agent_triggers_agent_id_enabled_status_idx" ON "agent_triggers"("agent_id", "enabled", "status");
CREATE INDEX "agent_trigger_deliveries_trigger_id_created_at_idx" ON "agent_trigger_deliveries"("trigger_id", "created_at");
CREATE INDEX "agent_trigger_deliveries_status_created_at_idx" ON "agent_trigger_deliveries"("status", "created_at");
CREATE INDEX "runs_trigger_id_created_at_idx" ON "runs"("trigger_id", "created_at");
CREATE UNIQUE INDEX "runs_trigger_delivery_id_key" ON "runs"("trigger_delivery_id");

ALTER TABLE "runs"
    ADD CONSTRAINT "runs_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "agent_triggers"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "runs_trigger_delivery_id_fkey" FOREIGN KEY ("trigger_delivery_id") REFERENCES "agent_trigger_deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
