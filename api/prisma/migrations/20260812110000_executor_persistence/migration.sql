-- Paired executor control-plane records. Executors are deliberately distinct
-- from MCP instances and hosted execution environments.

CREATE TYPE "ExecutorScopeKind" AS ENUM ('private', 'project', 'organization');
CREATE TYPE "ExecutorStatus" AS ENUM ('pending_pairing', 'online', 'offline', 'paused', 'draining', 'revoked', 'error');
CREATE TYPE "ExecutorProfile" AS ENUM ('workspace_sandbox', 'coding_session');
CREATE TYPE "ExecutorPrivateAssignmentPrincipalKind" AS ENUM ('user', 'agent');
CREATE TYPE "ExecutorPrivateAssignmentRole" AS ENUM ('use', 'admin');
CREATE TYPE "ExecutorAgentOperationGrantState" AS ENUM ('allowed', 'denied');
CREATE TYPE "ExecutorCapabilityReviewStatus" AS ENUM ('pending_review', 'active', 'disabled');
CREATE TYPE "ExecutorSessionStatus" AS ENUM ('pending', 'active', 'attention', 'detached', 'stopped', 'failed');
CREATE TYPE "ExecutorCommandReceiptState" AS ENUM ('leased', 'accepted', 'started', 'result_acknowledged', 'unknown_outcome');
CREATE TYPE "ExecutorContinuationSubject" AS ENUM ('invocation', 'access_change');
CREATE TYPE "ExecutorContinuationStatus" AS ENUM ('pending', 'confirmed', 'rejected', 'expired', 'consumed');

CREATE TABLE "executors" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID,
    "scope_kind" "ExecutorScopeKind" NOT NULL,
    "pairing_owner_user_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "profiles" "ExecutorProfile"[] NOT NULL DEFAULT ARRAY[]::"ExecutorProfile"[],
    "platform_facts" JSONB NOT NULL DEFAULT '{}',
    "machine_key_fingerprint" TEXT NOT NULL,
    "status" "ExecutorStatus" NOT NULL DEFAULT 'pending_pairing',
    "authorization_revision" INTEGER NOT NULL DEFAULT 1,
    "active_connection_epoch" BIGINT NOT NULL DEFAULT 0,
    "last_seen_at" TIMESTAMP(3),
    "status_detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "executors_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "executors_scope_project_shape_check" CHECK (
      ("scope_kind" = 'project' AND "project_id" IS NOT NULL)
      OR ("scope_kind" IN ('private', 'organization') AND "project_id" IS NULL)
    )
);

CREATE TABLE "executor_enrollments" (
    "id" UUID NOT NULL,
    "executor_id" UUID NOT NULL,
    "challenge_verifier" TEXT NOT NULL,
    "pending_public_key" TEXT,
    "pending_fingerprint" TEXT,
    "descriptor_digest" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "executor_enrollments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "executor_capability_revisions" (
    "id" UUID NOT NULL,
    "executor_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "descriptor" JSONB NOT NULL,
    "local_policy_digest" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "review_status" "ExecutorCapabilityReviewStatus" NOT NULL DEFAULT 'pending_review',
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "executor_capability_revisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "executor_private_assignments" (
    "id" UUID NOT NULL,
    "executor_id" UUID NOT NULL,
    "principal_kind" "ExecutorPrivateAssignmentPrincipalKind" NOT NULL,
    "user_id" UUID,
    "agent_id" UUID,
    "role" "ExecutorPrivateAssignmentRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "executor_private_assignments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "executor_private_assignments_principal_shape_check" CHECK (
      ("principal_kind" = 'user' AND "user_id" IS NOT NULL AND "agent_id" IS NULL)
      OR ("principal_kind" = 'agent' AND "agent_id" IS NOT NULL AND "user_id" IS NULL AND "role" = 'use')
    )
);

CREATE TABLE "executor_agent_operation_grants" (
    "id" UUID NOT NULL,
    "executor_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "operation_key" TEXT NOT NULL,
    "state" "ExecutorAgentOperationGrantState" NOT NULL,
    "authorization_revision" INTEGER NOT NULL,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "executor_agent_operation_grants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "executor_sessions" (
    "id" UUID NOT NULL,
    "executor_id" UUID NOT NULL,
    "run_id" UUID,
    "profile" "ExecutorProfile" NOT NULL,
    "workspace_grant_digest" TEXT NOT NULL,
    "status" "ExecutorSessionStatus" NOT NULL DEFAULT 'pending',
    "control_lease_user_id" UUID,
    "control_lease_expires_at" TIMESTAMP(3),
    "terminal_receipt" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "executor_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "executor_bindings" (
    "id" UUID NOT NULL,
    "executor_id" UUID NOT NULL,
    "capability_revision_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "session_id" UUID,
    "operation_key" TEXT NOT NULL,
    "authorization_revision" INTEGER NOT NULL,
    "fence" BIGINT NOT NULL,
    "candidate_handle_digest" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "executor_bindings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "executor_commands" (
    "id" UUID NOT NULL,
    "binding_id" UUID NOT NULL,
    "queue_job_id" UUID NOT NULL,
    "tool_call_id" UUID NOT NULL,
    "state" "ExecutorCommandReceiptState" NOT NULL DEFAULT 'leased',
    "argument_digest" TEXT NOT NULL,
    "delivery_payload_ciphertext" TEXT,
    "payload_expires_at" TIMESTAMP(3),
    "result_digest" TEXT,
    "accepted_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "executor_commands_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "executor_continuations" (
    "id" UUID NOT NULL,
    "executor_id" UUID NOT NULL,
    "binding_id" UUID,
    "subject" "ExecutorContinuationSubject" NOT NULL,
    "status" "ExecutorContinuationStatus" NOT NULL DEFAULT 'pending',
    "actor_user_id" UUID NOT NULL,
    "subject_digest" TEXT NOT NULL,
    "revisions" JSONB NOT NULL DEFAULT '{}',
    "confirmation_token_hash" TEXT,
    "verification_challenge_id" UUID,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "executor_continuations_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tool_calls" ADD COLUMN "executor_binding_id" UUID;

ALTER TABLE "projects" ADD CONSTRAINT "projects_id_organization_id_key" UNIQUE ("id", "organization_id");

CREATE UNIQUE INDEX "executor_enrollments_challenge_verifier_key" ON "executor_enrollments"("challenge_verifier");
CREATE INDEX "executor_enrollments_executor_id_expires_at_idx" ON "executor_enrollments"("executor_id", "expires_at");
CREATE UNIQUE INDEX "executor_capability_revisions_executor_id_revision_key" ON "executor_capability_revisions"("executor_id", "revision");
CREATE INDEX "executor_capability_revisions_executor_id_review_status_idx" ON "executor_capability_revisions"("executor_id", "review_status");
CREATE UNIQUE INDEX "executor_private_assignments_executor_id_user_id_key" ON "executor_private_assignments"("executor_id", "user_id");
CREATE UNIQUE INDEX "executor_private_assignments_executor_id_agent_id_key" ON "executor_private_assignments"("executor_id", "agent_id");
CREATE INDEX "executor_private_assignments_user_id_idx" ON "executor_private_assignments"("user_id");
CREATE INDEX "executor_private_assignments_agent_id_idx" ON "executor_private_assignments"("agent_id");
CREATE UNIQUE INDEX "executor_agent_operation_grants_executor_id_agent_id_operation_key_key" ON "executor_agent_operation_grants"("executor_id", "agent_id", "operation_key");
CREATE INDEX "executor_agent_operation_grants_agent_id_state_idx" ON "executor_agent_operation_grants"("agent_id", "state");
CREATE INDEX "executor_sessions_executor_id_status_idx" ON "executor_sessions"("executor_id", "status");
CREATE INDEX "executor_sessions_run_id_idx" ON "executor_sessions"("run_id");
CREATE UNIQUE INDEX "executor_bindings_run_id_operation_key_key" ON "executor_bindings"("run_id", "operation_key");
CREATE INDEX "executor_bindings_executor_id_created_at_idx" ON "executor_bindings"("executor_id", "created_at");
CREATE UNIQUE INDEX "executor_commands_queue_job_id_key" ON "executor_commands"("queue_job_id");
CREATE UNIQUE INDEX "executor_commands_tool_call_id_key" ON "executor_commands"("tool_call_id");
CREATE INDEX "executor_commands_binding_id_state_idx" ON "executor_commands"("binding_id", "state");
CREATE UNIQUE INDEX "executor_continuations_confirmation_token_hash_key" ON "executor_continuations"("confirmation_token_hash");
CREATE INDEX "executor_continuations_executor_id_status_expires_at_idx" ON "executor_continuations"("executor_id", "status", "expires_at");
CREATE INDEX "executor_continuations_actor_user_id_status_idx" ON "executor_continuations"("actor_user_id", "status");
CREATE INDEX "tool_calls_executor_binding_id_idx" ON "tool_calls"("executor_binding_id");
CREATE INDEX "executors_organization_id_scope_kind_status_idx" ON "executors"("organization_id", "scope_kind", "status");
CREATE INDEX "executors_project_id_idx" ON "executors"("project_id");
CREATE INDEX "executors_pairing_owner_user_id_idx" ON "executors"("pairing_owner_user_id");

ALTER TABLE "executors" ADD CONSTRAINT "executors_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "executors" ADD CONSTRAINT "executors_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "executors" ADD CONSTRAINT "executors_project_organization_id_fkey" FOREIGN KEY ("project_id", "organization_id") REFERENCES "projects"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "executors" ADD CONSTRAINT "executors_pairing_owner_user_id_fkey" FOREIGN KEY ("pairing_owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "executor_enrollments" ADD CONSTRAINT "executor_enrollments_executor_id_fkey" FOREIGN KEY ("executor_id") REFERENCES "executors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "executor_capability_revisions" ADD CONSTRAINT "executor_capability_revisions_executor_id_fkey" FOREIGN KEY ("executor_id") REFERENCES "executors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "executor_capability_revisions" ADD CONSTRAINT "executor_capability_revisions_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "executor_private_assignments" ADD CONSTRAINT "executor_private_assignments_executor_id_fkey" FOREIGN KEY ("executor_id") REFERENCES "executors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "executor_private_assignments" ADD CONSTRAINT "executor_private_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "executor_private_assignments" ADD CONSTRAINT "executor_private_assignments_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "executor_agent_operation_grants" ADD CONSTRAINT "executor_agent_operation_grants_executor_id_fkey" FOREIGN KEY ("executor_id") REFERENCES "executors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "executor_agent_operation_grants" ADD CONSTRAINT "executor_agent_operation_grants_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "executor_agent_operation_grants" ADD CONSTRAINT "executor_agent_operation_grants_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "executor_sessions" ADD CONSTRAINT "executor_sessions_executor_id_fkey" FOREIGN KEY ("executor_id") REFERENCES "executors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "executor_sessions" ADD CONSTRAINT "executor_sessions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "executor_sessions" ADD CONSTRAINT "executor_sessions_control_lease_user_id_fkey" FOREIGN KEY ("control_lease_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "executor_bindings" ADD CONSTRAINT "executor_bindings_executor_id_fkey" FOREIGN KEY ("executor_id") REFERENCES "executors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "executor_bindings" ADD CONSTRAINT "executor_bindings_capability_revision_id_fkey" FOREIGN KEY ("capability_revision_id") REFERENCES "executor_capability_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "executor_bindings" ADD CONSTRAINT "executor_bindings_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "executor_bindings" ADD CONSTRAINT "executor_bindings_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "executor_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "executor_commands" ADD CONSTRAINT "executor_commands_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "executor_bindings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "executor_commands" ADD CONSTRAINT "executor_commands_queue_job_id_fkey" FOREIGN KEY ("queue_job_id") REFERENCES "queue_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "executor_commands" ADD CONSTRAINT "executor_commands_tool_call_id_fkey" FOREIGN KEY ("tool_call_id") REFERENCES "tool_calls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "executor_continuations" ADD CONSTRAINT "executor_continuations_executor_id_fkey" FOREIGN KEY ("executor_id") REFERENCES "executors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "executor_continuations" ADD CONSTRAINT "executor_continuations_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "executor_bindings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "executor_continuations" ADD CONSTRAINT "executor_continuations_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_executor_binding_id_fkey" FOREIGN KEY ("executor_binding_id") REFERENCES "executor_bindings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A private executor never relies on a UI-only ownership convention. The
-- database rejects malformed principals, non-private assignment rows, and
-- cross-organization agent/user assignments before authorization code runs.
CREATE FUNCTION assert_executor_private_assignment() RETURNS trigger AS $$
DECLARE
  executor_scope "ExecutorScopeKind";
  executor_organization_id UUID;
BEGIN
  SELECT "scope_kind", "organization_id"
  INTO executor_scope, executor_organization_id
  FROM "executors"
  WHERE "id" = NEW."executor_id";

  IF NOT FOUND OR executor_scope <> 'private' THEN
    RAISE EXCEPTION 'private assignment requires a private executor';
  END IF;

  IF NEW."principal_kind" = 'user' THEN
    PERFORM 1
    FROM "organization_members"
    WHERE "organization_id" = executor_organization_id
      AND "user_id" = NEW."user_id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'private executor user must belong to its organization';
    END IF;
  ELSE
    PERFORM 1
    FROM "agents"
    WHERE "id" = NEW."agent_id"
      AND "organization_id" = executor_organization_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'private executor agent must belong to its organization';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER executor_private_assignments_tenant_guard
BEFORE INSERT OR UPDATE ON "executor_private_assignments"
FOR EACH ROW EXECUTE FUNCTION assert_executor_private_assignment();

CREATE FUNCTION assert_executor_operation_grant_tenant() RETURNS trigger AS $$
DECLARE
  executor_organization_id UUID;
BEGIN
  SELECT "organization_id"
  INTO executor_organization_id
  FROM "executors"
  WHERE "id" = NEW."executor_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'executor operation grant requires an executor';
  END IF;

  PERFORM 1
  FROM "agents"
  WHERE "id" = NEW."agent_id"
    AND "organization_id" = executor_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'executor operation grant agent must belong to the executor organization';
  END IF;

  PERFORM 1
  FROM "organization_members"
  WHERE "organization_id" = executor_organization_id
    AND "user_id" = NEW."updated_by_user_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'executor operation grants must be changed by an organization user';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER executor_agent_operation_grants_tenant_guard
BEFORE INSERT OR UPDATE ON "executor_agent_operation_grants"
FOR EACH ROW EXECUTE FUNCTION assert_executor_operation_grant_tenant();
