-- One cookie jar per person for the agents every person meets as their own.
--
-- The Personal Assistant is ONE agent row per organisation, and every global
-- agent is one row per slug. What makes them feel personal is a per-user DM
-- and a per-user presence binding — not a per-user agent. `agent_browsers` was
-- keyed by `(agent_id, connection_id)` with no user in it, so all of those
-- shared a single Browserbase context: one person signing into Gmail put their
-- mailbox inside every colleague's assistant, and anything a colleague signed
-- into landed in that person's jar. Watching a session was gated; whose
-- accounts the agent was *operating inside* was not gated at all.
--
-- After this, `principal_user_id` is the owner of the jar for a system-managed
-- agent, and NULL for an ordinary team agent — whose browser stays shared with
-- everyone who can reach it, which is what its sharing banner says and is
-- deliberate. That sharing is bounded by the agent's own team: an agent whose
-- browser holds logins can no longer be bound into another team's channel
-- (`packages/team-admin/src/agent-bindings.ts`).

-- AlterTable
ALTER TABLE "agent_browsers" ADD COLUMN "principal_user_id" UUID;

-- AddForeignKey: the principal must be a member of THIS organization, the same
-- composite tenancy `agent_browser_logins.member` uses.
ALTER TABLE "agent_browsers" ADD CONSTRAINT "agent_browsers_principal_fkey"
  FOREIGN KEY ("organization_id", "principal_user_id")
  REFERENCES "organization_members"("organization_id", "user_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- CreateIndex
CREATE INDEX "agent_browsers_organization_id_agent_id_principal_user_id_idx"
  ON "agent_browsers"("organization_id", "agent_id", "principal_user_id");

-- Two partial uniques replace the one that had no user in it. Kept partial on
-- `status = 'active'` for the original reason: a tombstoned row lingers until
-- its remote context is confirmed deleted and must not block a fresh browser.
DROP INDEX "agent_browsers_active_key";

CREATE UNIQUE INDEX "agent_browsers_active_shared_key"
  ON "agent_browsers"("agent_id", "connection_id")
  WHERE "status" = 'active'::"AgentBrowserStatus" AND "principal_user_id" IS NULL;

CREATE UNIQUE INDEX "agent_browsers_active_principal_key"
  ON "agent_browsers"("agent_id", "connection_id", "principal_user_id")
  WHERE "status" = 'active'::"AgentBrowserStatus" AND "principal_user_id" IS NOT NULL;

-- Existing rows. A shared cookie jar cannot be split between people, so every
-- active browser belonging to a system-managed agent has to be dealt with.
--
-- The carve-out first: where every login on the browser AND every session ever
-- opened against it belong to one person, that browser only ever held one
-- person's state, so it becomes theirs. This is the single-user install, and
-- nobody there is signed out.
WITH single_user AS (
  -- `array_agg` rather than `min`: Postgres has no MIN for uuid, and the
  -- HAVING below already proves there is exactly one distinct value to take.
  SELECT b.id AS browser_id, (array_agg(DISTINCT u.user_id))[1] AS user_id
  FROM "agent_browsers" b
  JOIN "agents" a ON a.id = b.agent_id
  LEFT JOIN LATERAL (
    SELECT l.user_id FROM "agent_browser_logins" l WHERE l.agent_browser_id = b.id
    UNION
    SELECT s.requested_by_user_id FROM "cloud_browser_sessions" s
    WHERE s.agent_browser_id = b.id AND s.requested_by_user_id IS NOT NULL
  ) u ON TRUE
  WHERE b.status = 'active' AND a.system_managed = TRUE
  GROUP BY b.id
  HAVING COUNT(DISTINCT u.user_id) = 1
)
UPDATE "agent_browsers" b
SET "principal_user_id" = s.user_id
FROM single_user s
WHERE b.id = s.browser_id
  -- Only when that person is still a member; otherwise it falls to the
  -- tombstone below rather than pointing at somebody who has left.
  AND EXISTS (
    SELECT 1 FROM "organization_members" m
    WHERE m.organization_id = b.organization_id AND m.user_id = s.user_id
  );

-- Everything else: a jar more than one person touched, or one nobody did.
-- Tombstoned rather than deleted, so the existing reconciler deletes the
-- Browserbase context that holds the cookies; its tabs cascade with the row.
-- The people affected are signed out and must sign in again — there is no
-- honest alternative, and leaving it would leave one person's mailbox live
-- inside a colleague's assistant.
UPDATE "agent_browsers" b
SET "status" = 'tombstoned'::"AgentBrowserStatus", "tombstoned_at" = NOW()
FROM "agents" a
WHERE a.id = b.agent_id
  AND a.system_managed = TRUE
  AND b.status = 'active'
  AND b.principal_user_id IS NULL;

-- Their login rows go with them: the audit fact is about a browser that is
-- being destroyed, and leaving them would make `loginCount` claim a fresh
-- browser is signed in when it is empty.
DELETE FROM "agent_browser_logins" l
USING "agent_browsers" b
WHERE l.agent_browser_id = b.id AND b.status = 'tombstoned'::"AgentBrowserStatus";
