ALTER TABLE "agent_mailbox_messages"
  ADD COLUMN "actor_id" uuid,
  ADD COLUMN "actor_type" text;
