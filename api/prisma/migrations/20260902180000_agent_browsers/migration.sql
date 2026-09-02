-- Phase 2 of cloud browsers: an agent's own durable browser, and the record
-- of who signed it into what.
-- Spec: docs/plans/2026-09-02-browserbase-cloud-browsers.md §4.2

-- A durable browser is usable, or tombstoned and awaiting the queue job that
-- deletes its Browserbase context. There is no third state: an external
-- delete cannot join a database transaction, so the row retires locally
-- first and the remote resource is reconciled after.
CREATE TYPE "AgentBrowserStatus" AS ENUM ('active', 'tombstoned');

CREATE TABLE "agent_browsers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "browserbase_context_id" TEXT NOT NULL,
    "status" "AgentBrowserStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    "tombstoned_at" TIMESTAMP(3),
    "last_error" TEXT,

    CONSTRAINT "agent_browsers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_browser_logins" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "agent_browser_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "service_hint" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_browser_logins_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "cloud_browser_sessions" ADD COLUMN "agent_browser_id" UUID;

CREATE INDEX "agent_browsers_organization_id_agent_id_idx" ON "agent_browsers"("organization_id", "agent_id");
CREATE INDEX "agent_browsers_connection_id_idx" ON "agent_browsers"("connection_id");
CREATE INDEX "agent_browser_logins_agent_browser_id_idx" ON "agent_browser_logins"("agent_browser_id");
CREATE INDEX "agent_browser_logins_organization_id_user_id_idx" ON "agent_browser_logins"("organization_id", "user_id");

-- One durable browser per agent per connection. Partial, because a
-- tombstoned row lingers until its remote context is confirmed deleted and
-- must not block the agent from getting a fresh browser in the meantime.
CREATE UNIQUE INDEX "agent_browsers_active_key"
  ON "agent_browsers"("agent_id", "connection_id")
  WHERE "status" = 'active'::"AgentBrowserStatus";

-- Lets the reconciler find contexts whose delete is still outstanding
-- without scanning live rows.
CREATE INDEX "agent_browsers_tombstoned_idx"
  ON "agent_browsers"("tombstoned_at")
  WHERE "status" = 'tombstoned'::"AgentBrowserStatus";

-- One live session per durable browser. Browserbase warns that two sessions
-- on one context make websites force logouts, so an agent running
-- concurrently in two threads gets a clean refusal rather than a corrupted
-- login state.
CREATE UNIQUE INDEX "cloud_browser_sessions_live_agent_browser_key"
  ON "cloud_browser_sessions"("agent_browser_id")
  WHERE "agent_browser_id" IS NOT NULL
    AND "status" IN (
      'allocating'::"CloudBrowserSessionStatus",
      'active'::"CloudBrowserSessionStatus",
      'releasing'::"CloudBrowserSessionStatus"
    );

-- The composite foreign keys below reference these columns, so the unique
-- index they need has to exist first.
CREATE UNIQUE INDEX "cloud_browser_connections_organization_id_id_key"
  ON "cloud_browser_connections"("organization_id", "id");

-- Composite tenancy, the `agents.owner_user_id` precedent: an agent browser's
-- agent and connection must both belong to THIS organization, so one tenant's
-- context can never be opened with another tenant's key. NoAction because on
-- a composite key SET NULL would blank organization_id too.
ALTER TABLE "agent_browsers" ADD CONSTRAINT "agent_browsers_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_browsers" ADD CONSTRAINT "agent_browsers_organization_id_agent_id_fkey"
  FOREIGN KEY ("organization_id", "agent_id") REFERENCES "agents"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "agent_browsers" ADD CONSTRAINT "agent_browsers_organization_id_connection_id_fkey"
  FOREIGN KEY ("organization_id", "connection_id") REFERENCES "cloud_browser_connections"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "agent_browser_logins" ADD CONSTRAINT "agent_browser_logins_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_browser_logins" ADD CONSTRAINT "agent_browser_logins_agent_browser_id_fkey"
  FOREIGN KEY ("agent_browser_id") REFERENCES "agent_browsers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The signer must be a member of this organization. Membership rows are
-- retained through deactivation, so readers re-derive liveness.
ALTER TABLE "agent_browser_logins" ADD CONSTRAINT "agent_browser_logins_organization_id_user_id_fkey"
  FOREIGN KEY ("organization_id", "user_id") REFERENCES "organization_members"("organization_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "cloud_browser_sessions" ADD CONSTRAINT "cloud_browser_sessions_agent_browser_id_fkey"
  FOREIGN KEY ("agent_browser_id") REFERENCES "agent_browsers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
