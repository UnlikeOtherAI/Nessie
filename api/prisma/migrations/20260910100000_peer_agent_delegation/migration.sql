-- Expand-only capability marker for durable, bounded peer delegation. NULL is
-- ordinary mailbox traffic and must remain that way during a rolling deploy.
ALTER TABLE "agent_mailbox_messages"
  ADD COLUMN IF NOT EXISTS "peer_delegation_depth" INTEGER;
