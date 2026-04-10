ALTER TABLE "agent_mailbox_messages"
ADD COLUMN "thread_id" UUID;

CREATE INDEX "agent_mailbox_messages_thread_id_status_visible_at_idx"
ON "agent_mailbox_messages"("thread_id", "status", "visible_at");
