-- Peer delegation already carries its scope basis. Preserve the separate
-- original-human lineage too: `null` is an explicit unknown-author marker.
ALTER TABLE "agent_mailbox_messages"
  ADD COLUMN IF NOT EXISTS "disclosure_sources" JSONB NOT NULL DEFAULT '[]'::jsonb;
