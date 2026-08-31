-- Agent documents ownership: a space can be the durable documents home for an
-- agent. Additive and backfill-free on purpose: `created_by` records authorship,
-- not ownership, so deriving this pointer for existing spaces would fabricate a
-- fact the database never recorded.
--
-- See docs/plans/2026-08-31-agent-documents.md.

ALTER TABLE "knowledge_spaces" ADD COLUMN "owner_agent_id" UUID;

-- Keep deletion an explicit product decision. Cascading would silently destroy
-- an agent's document home, while SET NULL would erase its ownership and turn it
-- into an ordinary space; neither outcome is safe to infer from deleting an
-- agent. See docs/plans/2026-08-31-agent-documents.md section 2.1.
ALTER TABLE "knowledge_spaces"
  ADD CONSTRAINT "knowledge_spaces_owner_agent_id_fkey"
  FOREIGN KEY ("owner_agent_id")
  REFERENCES "agents"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Fail closed at the storage boundary. Existing user-side access arms can admit
-- non-private spaces, so allowing an owned space with another visibility would
-- expose agent documents before the separate agent-audience read arm is applied.
-- See docs/plans/2026-08-31-agent-documents.md section 2.1.
ALTER TABLE "knowledge_spaces"
  ADD CONSTRAINT "knowledge_spaces_owner_agent_private_chk"
  CHECK (
    "owner_agent_id" IS NULL
    OR "visibility" = 'private'::"ThoughtVisibility"
  );

-- "Which document spaces does this agent own in this organization" is the
-- provisioning lookup; indexing both facts avoids scanning every knowledge
-- space whenever a run resolves its agent's home.
CREATE INDEX "knowledge_spaces_organization_id_owner_agent_id_idx"
  ON "knowledge_spaces"("organization_id", "owner_agent_id");
