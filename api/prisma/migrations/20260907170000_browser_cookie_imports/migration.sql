CREATE TYPE "BrowserCookieImportState" AS ENUM ('pending', 'importing', 'imported', 'failed', 'unknown', 'cancelled');

ALTER TABLE "executors"
  ADD CONSTRAINT "executors_organization_id_id_key" UNIQUE ("organization_id", "id");

CREATE TABLE "browser_cookie_imports" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "executor_id" UUID NOT NULL,
    "origins" TEXT[] NOT NULL,
    "state" "BrowserCookieImportState" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "imported_at" TIMESTAMP(3),
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "browser_cookie_imports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "browser_cookie_imports_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "browser_cookie_imports_actor_tenant_fkey"
      FOREIGN KEY ("organization_id", "actor_id") REFERENCES "organization_members"("organization_id", "user_id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "browser_cookie_imports_agent_tenant_fkey"
      FOREIGN KEY ("organization_id", "agent_id") REFERENCES "agents"("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "browser_cookie_imports_thread_id_fkey"
      FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "browser_cookie_imports_executor_tenant_fkey"
      FOREIGN KEY ("organization_id", "executor_id") REFERENCES "executors"("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "browser_cookie_imports_organization_id_actor_id_state_idx"
  ON "browser_cookie_imports"("organization_id", "actor_id", "state");
CREATE INDEX "browser_cookie_imports_executor_id_state_expires_at_idx"
  ON "browser_cookie_imports"("executor_id", "state", "expires_at");
CREATE INDEX "browser_cookie_imports_thread_id_state_idx"
  ON "browser_cookie_imports"("thread_id", "state");
