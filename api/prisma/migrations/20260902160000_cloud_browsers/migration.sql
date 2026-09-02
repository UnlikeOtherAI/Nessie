-- Cloud browsers (Browserbase) as a second transport behind the agent browser
-- surface. Phase 1: bring-your-own-key connections at two scopes, and the
-- session lifecycle rows that keep browser-hours from leaking.
-- Spec: docs/plans/2026-09-02-browserbase-cloud-browsers.md

-- Which account pays for, and can replay, browsers opened through a
-- connection. Decided by the surface that accepted the key, never inferred
-- from the key: Browserbase authenticates by API key only.
CREATE TYPE "CloudBrowserConnectionScope" AS ENUM ('organization', 'user');

-- A capability that can stop working owns the way a person finds out.
CREATE TYPE "CloudBrowserConnectionStatus" AS ENUM ('active', 'needs_attention', 'disabled');

-- A remote resource's lifecycle, not a boolean: a create that times out may
-- still have produced a paid session, and `active` may only clear once
-- Browserbase confirms termination (two sessions on one context make sites
-- force logouts).
CREATE TYPE "CloudBrowserSessionStatus" AS ENUM ('allocating', 'active', 'releasing', 'released', 'failed', 'unknown');

CREATE TABLE "cloud_browser_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "scope" "CloudBrowserConnectionScope" NOT NULL,
    "user_id" UUID,
    "project_id" TEXT NOT NULL,
    "api_key_ref" TEXT NOT NULL,
    "status" "CloudBrowserConnectionStatus" NOT NULL DEFAULT 'active',
    "health_reason" TEXT,
    "health_detail" TEXT,
    "health_revision" INTEGER NOT NULL DEFAULT 0,
    "health_checked_at" TIMESTAMP(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cloud_browser_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cloud_browser_sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "browserbase_session_id" TEXT,
    "status" "CloudBrowserSessionStatus" NOT NULL DEFAULT 'allocating',
    "authenticated" BOOLEAN NOT NULL DEFAULT false,
    "requested_by_user_id" UUID,
    "controlled_by_user_id" UUID,
    "control_claimed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "released_by" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cloud_browser_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cloud_browser_connections_organization_id_scope_idx" ON "cloud_browser_connections"("organization_id", "scope");
CREATE INDEX "cloud_browser_sessions_organization_id_status_idx" ON "cloud_browser_sessions"("organization_id", "status");
CREATE INDEX "cloud_browser_sessions_thread_id_status_idx" ON "cloud_browser_sessions"("thread_id", "status");
CREATE INDEX "cloud_browser_sessions_connection_id_started_at_idx" ON "cloud_browser_sessions"("connection_id", "started_at");

-- `user_id` is exactly the scope discriminator: NULL for the organization
-- subscription, the owning member for a personal connection. Without this a
-- malformed write could produce an org row owned by one member, or a user row
-- owned by nobody — and the partial unique indexes below would then disagree
-- with the scope they are trying to enforce.
ALTER TABLE "cloud_browser_connections"
  ADD CONSTRAINT "cloud_browser_connections_scope_user_chk" CHECK (
    ("scope" = 'organization'::"CloudBrowserConnectionScope" AND "user_id" IS NULL)
    OR ("scope" = 'user'::"CloudBrowserConnectionScope" AND "user_id" IS NOT NULL)
  );

-- Prisma cannot express partial uniqueness. One organization subscription per
-- organization; one personal connection per member. Postgres treats NULLs as
-- distinct, so a plain UNIQUE on (organization_id, user_id) would let an
-- organization accumulate rows.
CREATE UNIQUE INDEX "cloud_browser_connections_org_scope_key"
  ON "cloud_browser_connections"("organization_id")
  WHERE "scope" = 'organization'::"CloudBrowserConnectionScope";

CREATE UNIQUE INDEX "cloud_browser_connections_user_scope_key"
  ON "cloud_browser_connections"("organization_id", "user_id")
  WHERE "scope" = 'user'::"CloudBrowserConnectionScope";

-- One live session per run: `goto`/`observe`/`close` must always resolve an
-- unambiguous current browser, and a run that could hold several would leak
-- billable sessions past its own release.
CREATE UNIQUE INDEX "cloud_browser_sessions_live_run_key"
  ON "cloud_browser_sessions"("run_id")
  WHERE "status" IN (
    'allocating'::"CloudBrowserSessionStatus",
    'active'::"CloudBrowserSessionStatus",
    'releasing'::"CloudBrowserSessionStatus"
  );

-- Supports the reaper's "what is still live and past its TTL" scan without
-- walking every historical session.
CREATE INDEX "cloud_browser_sessions_live_expiry_idx"
  ON "cloud_browser_sessions"("expires_at")
  WHERE "status" IN (
    'allocating'::"CloudBrowserSessionStatus",
    'active'::"CloudBrowserSessionStatus",
    'releasing'::"CloudBrowserSessionStatus"
  );

ALTER TABLE "cloud_browser_connections" ADD CONSTRAINT "cloud_browser_connections_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenancy at the storage boundary, the `agents.owner_user_id` precedent: a
-- personal connection's owner must be a member of THIS organization. NoAction
-- because on a composite key SET NULL would blank organization_id too.
ALTER TABLE "cloud_browser_connections" ADD CONSTRAINT "cloud_browser_connections_organization_id_user_id_fkey"
  FOREIGN KEY ("organization_id", "user_id") REFERENCES "organization_members"("organization_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "cloud_browser_sessions" ADD CONSTRAINT "cloud_browser_sessions_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cloud_browser_sessions" ADD CONSTRAINT "cloud_browser_sessions_connection_id_fkey"
  FOREIGN KEY ("connection_id") REFERENCES "cloud_browser_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cloud_browser_sessions" ADD CONSTRAINT "cloud_browser_sessions_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cloud_browser_sessions" ADD CONSTRAINT "cloud_browser_sessions_thread_id_fkey"
  FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cloud_browser_sessions" ADD CONSTRAINT "cloud_browser_sessions_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
