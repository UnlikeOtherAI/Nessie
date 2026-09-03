-- One live handoff of a conversation to a global agent, per person per target
-- (docs/plans/2026-09-02-agent-designer-global-agent.md, D8).
--
-- The row is `agent_handoff`'s loop bound: a repeated ask, a queue retry, or a
-- continuation run (new run id, same request) finds it inside its cooldown and
-- converges on the briefing already waiting in the person's DM instead of
-- stacking a second one. Convergence is serialized by a
-- `pg_advisory_xact_lock` on (requested_by_user_id, target_slug) — the
-- agent_app_connection_requests precedent — so there is deliberately no unique
-- constraint on the pair: superseded rows are retained as history.
CREATE TABLE "agent_handoff_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "target_slug" TEXT NOT NULL,
    "target_agent_id" UUID NOT NULL,
    "from_agent_id" UUID NOT NULL,
    "origin_run_id" UUID NOT NULL,
    "destination_channel_id" UUID NOT NULL,
    "destination_thread_id" UUID NOT NULL,
    "brief_message_id" UUID NOT NULL,
    "cooldown_until" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "superseded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_handoff_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_handoff_requests_brief_message_id_key" ON "agent_handoff_requests"("brief_message_id");

-- CreateIndex
CREATE INDEX "agent_handoff_requester_target_created_idx" ON "agent_handoff_requests"("requested_by_user_id", "target_slug", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agent_handoff_organization_expires_idx" ON "agent_handoff_requests"("organization_id", "expires_at");

-- AddForeignKey
ALTER TABLE "agent_handoff_requests" ADD CONSTRAINT "agent_handoff_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_handoff_requests" ADD CONSTRAINT "agent_handoff_requests_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_handoff_requests" ADD CONSTRAINT "agent_handoff_requests_target_agent_id_fkey" FOREIGN KEY ("target_agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_handoff_requests" ADD CONSTRAINT "agent_handoff_requests_from_agent_id_fkey" FOREIGN KEY ("from_agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_handoff_requests" ADD CONSTRAINT "agent_handoff_requests_origin_run_id_fkey" FOREIGN KEY ("origin_run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_handoff_requests" ADD CONSTRAINT "agent_handoff_requests_destination_channel_id_fkey" FOREIGN KEY ("destination_channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_handoff_requests" ADD CONSTRAINT "agent_handoff_requests_destination_thread_id_fkey" FOREIGN KEY ("destination_thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_handoff_requests" ADD CONSTRAINT "agent_handoff_requests_brief_message_id_fkey" FOREIGN KEY ("brief_message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
