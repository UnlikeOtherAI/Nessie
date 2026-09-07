CREATE TYPE "BrowserPersonalAccessGrantStatus" AS ENUM ('pending', 'active', 'revoked', 'expired');
CREATE TYPE "CloudBrowserInteractionTransport" AS ENUM ('legacy', 'mediated');

ALTER TABLE "cloud_browser_sessions"
  ADD COLUMN "interaction_transport" "CloudBrowserInteractionTransport" NOT NULL DEFAULT 'legacy';

ALTER TABLE "runs"
  ADD CONSTRAINT "runs_id_agent_id_thread_id_key" UNIQUE ("id", "agent_id", "thread_id");

CREATE TABLE "browser_personal_access_grants" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "origins" TEXT[] NOT NULL,
    "status" "BrowserPersonalAccessGrantStatus" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "session_id" UUID,
    "activated_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "browser_personal_access_grants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "browser_personal_access_grants_session_id_key" UNIQUE ("session_id"),
    CONSTRAINT "browser_personal_access_grants_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "browser_personal_access_grants_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "browser_personal_access_grants_agent_org_fkey"
      FOREIGN KEY ("organization_id", "agent_id") REFERENCES "agents"("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "browser_personal_access_grants_member_fkey"
      FOREIGN KEY ("organization_id", "user_id") REFERENCES "organization_members"("organization_id", "user_id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "browser_personal_access_grants_run_agent_thread_fkey"
      FOREIGN KEY ("run_id", "agent_id", "thread_id") REFERENCES "runs"("id", "agent_id", "thread_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "browser_personal_access_grants_thread_id_fkey"
      FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "browser_personal_access_grants_session_id_fkey"
      FOREIGN KEY ("session_id") REFERENCES "cloud_browser_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "browser_personal_access_grants_org_user_status_expires_idx"
  ON "browser_personal_access_grants"("organization_id", "user_id", "status", "expires_at");
CREATE INDEX "browser_personal_access_grants_run_status_idx"
  ON "browser_personal_access_grants"("run_id", "status");
