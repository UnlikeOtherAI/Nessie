-- Agent chat cards: one interactive card system for every agent.
-- Design: docs/plans/2026-09-01-agent-chat-cards.md

-- A run suspended on a card is non-terminal and holds its (agent, thread) slot,
-- exactly like `waiting_approval`. Deliberately a distinct value: the status
-- label is user-visible, and "waiting for approval" is the wrong words for a form.
ALTER TYPE "RunStatus" ADD VALUE IF NOT EXISTS 'waiting_input';
ALTER TYPE "AgentStatus" ADD VALUE IF NOT EXISTS 'waiting_input';

CREATE TYPE "AgentCardStatus" AS ENUM ('open', 'resolved', 'expired', 'cancelled');

CREATE TABLE "agent_cards" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "wait_run_id" UUID,
    "resume_state" JSONB,
    "spec" JSONB NOT NULL,
    "respondent_user_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "status" "AgentCardStatus" NOT NULL DEFAULT 'open',
    "expires_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "resolved_by_user_id" UUID,
    "resolved_action_key" TEXT,
    "resolution_values" JSONB,
    "response_message_id" UUID,
    "secret_outcomes" JSONB,
    "resumed_by_run_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_cards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_cards_message_id_key" ON "agent_cards"("message_id");
CREATE UNIQUE INDEX "agent_cards_wait_run_id_key" ON "agent_cards"("wait_run_id");
CREATE UNIQUE INDEX "agent_cards_response_message_id_key" ON "agent_cards"("response_message_id");
CREATE UNIQUE INDEX "agent_cards_resumed_by_run_id_key" ON "agent_cards"("resumed_by_run_id");
CREATE INDEX "agent_cards_organization_id_status_expires_at_idx" ON "agent_cards"("organization_id", "status", "expires_at");
CREATE INDEX "agent_cards_thread_id_status_idx" ON "agent_cards"("thread_id", "status");
CREATE INDEX "agent_cards_agent_id_status_idx" ON "agent_cards"("agent_id", "status");

ALTER TABLE "agent_cards" ADD CONSTRAINT "agent_cards_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_cards" ADD CONSTRAINT "agent_cards_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_cards" ADD CONSTRAINT "agent_cards_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_cards" ADD CONSTRAINT "agent_cards_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_cards" ADD CONSTRAINT "agent_cards_response_message_id_fkey" FOREIGN KEY ("response_message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_cards" ADD CONSTRAINT "agent_cards_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_cards" ADD CONSTRAINT "agent_cards_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_cards" ADD CONSTRAINT "agent_cards_wait_run_id_fkey" FOREIGN KEY ("wait_run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_cards" ADD CONSTRAINT "agent_cards_resumed_by_run_id_fkey" FOREIGN KEY ("resumed_by_run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_cards" ADD CONSTRAINT "agent_cards_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
