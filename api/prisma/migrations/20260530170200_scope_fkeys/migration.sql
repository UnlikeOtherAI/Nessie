-- Add scope foreign keys for operational tables that previously carried bare
-- @db.Uuid columns with no referential integrity: plans, approval_requests,
-- resource_locks, tool_grants, and mcp_catalog_entries.
--
-- Required (NOT NULL) owning refs use ON DELETE CASCADE; nullable scope refs use
-- ON DELETE SET NULL so deleting a project/team/channel/run/task/agent/user
-- nulls the pointer rather than blocking the delete.
--
-- ORPHAN-CLEANUP GUARD: before applying, verify no row references a missing
-- parent for the CASCADE/required columns below. For each ADD CONSTRAINT on a
-- NOT NULL column (plans.organization_id, approval_requests.organization_id,
-- resource_locks.organization_id, resource_locks.agent_id) run a LEFT JOIN
-- orphan count and reconcile any non-zero result first. Nullable SET NULL refs
-- with orphaned values must be NULLed before the FK is added.

-- ── plans ──────────────────────────────────────────────────────────────────
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_channel_id_fkey"
  FOREIGN KEY ("channel_id") REFERENCES "channels"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "runs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── approval_requests ────────────────────────────────────────────────────────
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_channel_id_fkey"
  FOREIGN KEY ("channel_id") REFERENCES "channels"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "runs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── resource_locks ──────────────────────────────────────────────────────────
ALTER TABLE "resource_locks"
  ADD CONSTRAINT "resource_locks_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "resource_locks"
  ADD CONSTRAINT "resource_locks_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "resource_locks"
  ADD CONSTRAINT "resource_locks_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "resource_locks"
  ADD CONSTRAINT "resource_locks_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "runs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── tool_grants ──────────────────────────────────────────────────────────────
-- role_id is intentionally left without a FK (free-form RBAC role id, no table).
ALTER TABLE "tool_grants"
  ADD CONSTRAINT "tool_grants_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── mcp_catalog_entries ──────────────────────────────────────────────────────
-- created_by is intentionally left without a FK (NOT NULL provenance column;
-- SET NULL impossible, RESTRICT would block legitimate user deletes).
ALTER TABLE "mcp_catalog_entries"
  ADD CONSTRAINT "mcp_catalog_entries_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mcp_catalog_entries"
  ADD CONSTRAINT "mcp_catalog_entries_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "mcp_catalog_entries"
  ADD CONSTRAINT "mcp_catalog_entries_reviewed_by_fkey"
  FOREIGN KEY ("reviewed_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
