-- Visibility is independent from stewardship: workspace agents keep today's
-- entitlement behaviour, while private agents are visible only to their live
-- owner. Existing rows deliberately remain workspace-visible through the
-- column default; there is no privacy backfill the historical data can prove.
CREATE TYPE "AgentVisibility" AS ENUM ('workspace', 'private');

ALTER TABLE "agents"
  ADD COLUMN "visibility" "AgentVisibility" NOT NULL DEFAULT 'workspace';

-- A private row must resolve to a human steward and can never be one of the
-- system-managed organization singletons.
ALTER TABLE "agents"
  ADD CONSTRAINT "agents_private_visibility_chk" CHECK (
    "visibility" = 'workspace'::"AgentVisibility"
    OR ("owner_user_id" IS NOT NULL AND "system_managed" = false)
  );

-- Supports the owner arm of the shared visibility predicate without scanning
-- every workspace-visible agent in the organization.
CREATE INDEX "agents_org_visibility_owner_idx"
  ON "agents"("organization_id", "visibility", "owner_user_id");

-- Bindings are written outside the workspace-admin service in bootstrap and DM
-- conversion paths, so placement needs a storage-level floor. A CHECK cannot
-- inspect the referenced agent row; this trigger covers raw INSERT and UPDATE.
CREATE OR REPLACE FUNCTION "reject_private_agent_binding"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "agents"
    WHERE "id" = NEW."agent_id"
      AND "visibility" = 'private'::"AgentVisibility"
  ) THEN
    RAISE EXCEPTION 'Private agents cannot be bound to channels'
      USING ERRCODE = '23514',
            CONSTRAINT = 'agent_bindings_private_agent_visibility';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "agent_bindings_private_agent_visibility_trg"
BEFORE INSERT OR UPDATE ON "agent_bindings"
FOR EACH ROW
EXECUTE FUNCTION "reject_private_agent_binding"();
