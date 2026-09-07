-- Expand-only. An empty basis is the historical ordinary-mailbox meaning;
-- peer delegation writes its consumed-source chain explicitly.
ALTER TABLE "agent_mailbox_messages"
  ADD COLUMN IF NOT EXISTS "basis" JSONB NOT NULL DEFAULT '[]'::jsonb;
