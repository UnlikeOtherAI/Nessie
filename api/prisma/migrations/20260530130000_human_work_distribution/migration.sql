-- Human work distribution: assign tasks to people, route approvals to a role.

-- 1. Task: organization scope + human assignment fields
ALTER TABLE "tasks" ADD COLUMN "organization_id" UUID;
ALTER TABLE "tasks" ADD COLUMN "title" TEXT;
ALTER TABLE "tasks" ADD COLUMN "assignee_user_id" UUID;
ALTER TABLE "tasks" ADD COLUMN "owner_user_id" UUID;
ALTER TABLE "tasks" ADD COLUMN "created_by_user_id" UUID;

-- Backfill organization_id from the owning agent.
UPDATE "tasks" t
SET "organization_id" = a."organization_id"
FROM "agents" a
WHERE t."agent_id" = a."id"
  AND t."organization_id" IS NULL;

-- Legacy tasks whose agent predates multi-tenancy (agent.organization_id IS NULL)
-- fall back to the earliest organization so they stay visible rather than orphaned.
UPDATE "tasks"
SET "organization_id" = (SELECT "id" FROM "organizations" ORDER BY "created_at" ASC LIMIT 1)
WHERE "organization_id" IS NULL;

ALTER TABLE "tasks" ALTER COLUMN "organization_id" SET NOT NULL;

-- Human tasks may have no executor agent.
ALTER TABLE "tasks" ALTER COLUMN "agent_id" DROP NOT NULL;

-- Foreign keys
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_user_id_fkey"
  FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "tasks_organization_id_status_idx" ON "tasks"("organization_id", "status");
CREATE INDEX "tasks_assignee_user_id_status_idx" ON "tasks"("assignee_user_id", "status");
CREATE INDEX "tasks_owner_user_id_status_idx" ON "tasks"("owner_user_id", "status");

-- 2. ApprovalRequest: route resolution to a required approver role
ALTER TABLE "approval_requests" ADD COLUMN "required_approver_role" TEXT;
