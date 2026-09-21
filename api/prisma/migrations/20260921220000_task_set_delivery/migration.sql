ALTER TABLE "agent_mailbox_messages" ADD COLUMN "task_set_id" UUID;
ALTER TABLE "agent_mailbox_messages" ADD CONSTRAINT "agent_mailbox_messages_task_set_id_fkey"
  FOREIGN KEY ("task_set_id") REFERENCES "task_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "agent_mailbox_messages_task_set_id_idx" ON "agent_mailbox_messages"("task_set_id");
