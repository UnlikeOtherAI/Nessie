-- Agent stewardship: the person an agent belongs to — their "virtual employee".
--
-- Additive and backfill-free. `owner_user_id` stays NULL for every existing
-- agent on purpose: nothing in the schema records who created an agent
-- (`agent.created` was never emitted, and agent_bindings store no user), so any
-- backfill would be fabrication. NULL renders as "Unowned", a real category.
--
-- See docs/plans/2026-08-29-people-and-their-agents.md.

ALTER TABLE "agents" ADD COLUMN "owner_user_id" UUID;

-- Tenancy at the storage boundary. A bare FK to users(id) cannot express "the
-- owner is a member of THIS agent's organization", and one writer
-- (spawn_subtask) creates agents outside the shared creation chokepoint, so the
-- invariant cannot rest on service discipline alone.
--
-- ON DELETE NO ACTION, deliberately: on a COMPOSITE foreign key, SET NULL
-- blanks EVERY referencing column, which would wipe the agent's
-- organization_id along with its owner. organization_members rows are never
-- deleted (deactivation is a reversible flag), so this clause never fires.
--
-- This constraint proves the membership row EXISTS. It cannot prove the
-- membership is LIVE — deactivated rows are retained for audit history — so
-- every read re-derives `deactivated_at IS NULL` rather than trusting the FK.
ALTER TABLE "agents"
  ADD CONSTRAINT "agents_organization_id_owner_user_id_fkey"
  FOREIGN KEY ("organization_id", "owner_user_id")
  REFERENCES "organization_members"("organization_id", "user_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- An owned agent is never system-managed and never org-less. System agents (the
-- org-singleton Personal Assistant, the Librarian, external-agent peers) serve
-- every member through per-user DM keys, so naming one person as their owner
-- would be a lie; and ownership is only ever evaluated against an
-- organization's membership, so an owned org-less agent is unresolvable.
ALTER TABLE "agents"
  ADD CONSTRAINT "agents_owner_requires_org_scoped_shared_agent_chk"
  CHECK (
    "owner_user_id" IS NULL
    OR ("system_managed" = false AND "organization_id" IS NOT NULL)
  );

-- "Which agents does this person steward" — the first non-channel-derived agent
-- read in the codebase, and the people-and-their-agents tree's level-3 query.
CREATE INDEX "agents_organization_id_owner_user_id_idx"
  ON "agents"("organization_id", "owner_user_id");
