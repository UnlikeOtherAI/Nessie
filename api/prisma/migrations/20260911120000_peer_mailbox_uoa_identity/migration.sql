-- Peer mail is durable work. Persist only the verified UOA subject/org/team/
-- epoch tuple captured at delegation; it is provenance, not a credential or
-- identity authority, and Ledger validates it against the live account link.
ALTER TABLE "agent_mailbox_messages"
  ADD COLUMN "uoa_identity" JSONB;
