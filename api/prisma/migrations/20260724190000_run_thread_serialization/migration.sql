-- Per-(agent, thread) run serialization: durable pending-message markers that
-- the worker drains into one batched follow-up run after the in-flight run
-- reaches a terminal state.
CREATE TABLE "run_thread_pending_messages" (
    "seq" BIGSERIAL NOT NULL,
    "agent_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "interactive" BOOLEAN NOT NULL DEFAULT false,
    "actor_context" JSONB NOT NULL,
    "trigger_id" UUID,
    "trigger_delivery_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_thread_pending_messages_pkey" PRIMARY KEY ("seq")
);

-- One pending marker per (agent, message): the same message may pend for
-- several agents, but never twice for the same agent.
CREATE UNIQUE INDEX "run_thread_pending_messages_agent_id_message_id_key" ON "run_thread_pending_messages"("agent_id", "message_id");

-- Drain + sweep lookup: all pending rows for a thread in arrival order.
CREATE INDEX "run_thread_pending_messages_thread_id_seq_idx" ON "run_thread_pending_messages"("thread_id", "seq");

ALTER TABLE "run_thread_pending_messages" ADD CONSTRAINT "run_thread_pending_messages_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "run_thread_pending_messages" ADD CONSTRAINT "run_thread_pending_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "run_thread_pending_messages" ADD CONSTRAINT "run_thread_pending_messages_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Trigger provenance of a pended trigger fire: the drain copies the latest
-- pending row's linkage onto the batched follow-up run. SetNull so retiring a
-- trigger/delivery never blocks the pending marker.
ALTER TABLE "run_thread_pending_messages" ADD CONSTRAINT "run_thread_pending_messages_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "agent_triggers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "run_thread_pending_messages" ADD CONSTRAINT "run_thread_pending_messages_trigger_delivery_id_fkey" FOREIGN KEY ("trigger_delivery_id") REFERENCES "agent_trigger_deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
