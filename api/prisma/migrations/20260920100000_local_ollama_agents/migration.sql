-- Owner-host-only local Ollama lane.  This is purely additive: readers land
-- before writers, and existing agents/runs retain their present lane.
CREATE TYPE "LocalInferenceTransport" AS ENUM ('executor', 'desktop');
CREATE TYPE "LocalInferenceBindingStatus" AS ENUM (
  'pending', 'consented_pending_activation', 'active', 'needs_rebinding', 'revoked'
);
CREATE TYPE "LocalInferenceAttemptState" AS ENUM (
  'queued', 'leased', 'accepted', 'completed', 'failed', 'cancelled', 'expired'
);

ALTER TYPE "InferenceBillingSource" ADD VALUE 'local_device';
ALTER TYPE "UserAlertKind" ADD VALUE 'local_inference_health';

CREATE TABLE "local_inference_hosts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "custodian_user_id" UUID NOT NULL,
  "transport" "LocalInferenceTransport" NOT NULL,
  "executor_id" UUID,
  "public_key" TEXT,
  "public_key_fingerprint" TEXT,
  "display_label" TEXT NOT NULL,
  "authorization_revision" INTEGER NOT NULL DEFAULT 1,
  "connection_epoch" INTEGER NOT NULL DEFAULT 1,
  "policy_revision" INTEGER NOT NULL DEFAULT 0,
  "last_seen_at" TIMESTAMP(3),
  "inventory" JSONB,
  "inventory_observed_at" TIMESTAMP(3),
  "paused_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "health_reason" TEXT,
  "health_revision" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "local_inference_hosts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "local_inference_host_transport_authority_chk" CHECK (
    ("transport" = 'executor' AND "executor_id" IS NOT NULL AND "public_key" IS NULL AND "public_key_fingerprint" IS NULL)
    OR ("transport" = 'desktop' AND "executor_id" IS NULL AND "public_key" IS NOT NULL AND "public_key_fingerprint" IS NOT NULL)
  ),
  CONSTRAINT "local_inference_hosts_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "local_inference_hosts_custodian_fkey"
    FOREIGN KEY ("organization_id", "custodian_user_id")
    REFERENCES "organization_members"("organization_id", "user_id") ON DELETE NO ACTION
);
CREATE UNIQUE INDEX "local_inference_hosts_executor_id_key"
  ON "local_inference_hosts"("executor_id") WHERE "executor_id" IS NOT NULL;
CREATE UNIQUE INDEX "local_inference_hosts_public_key_fingerprint_key"
  ON "local_inference_hosts"("public_key_fingerprint") WHERE "public_key_fingerprint" IS NOT NULL;
CREATE UNIQUE INDEX "local_inference_hosts_org_id_key" ON "local_inference_hosts"("organization_id", "id");
CREATE INDEX "local_inference_hosts_org_custodian_idx" ON "local_inference_hosts"("organization_id", "custodian_user_id");
CREATE INDEX "local_inference_hosts_org_seen_idx" ON "local_inference_hosts"("organization_id", "last_seen_at");

CREATE TABLE "local_inference_policy_versions" (
  "organization_id" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "local_inference_policy_versions_pkey" PRIMARY KEY ("organization_id"),
  CONSTRAINT "local_inference_policy_versions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE TABLE "agent_local_inference_bindings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "agent_id" UUID NOT NULL,
  "host_id" UUID NOT NULL,
  "model_name" TEXT NOT NULL,
  "manifest_digest" TEXT NOT NULL,
  "capability_snapshot" JSONB NOT NULL,
  "num_ctx" INTEGER NOT NULL,
  "agent_edit_revision" TIMESTAMP(3) NOT NULL,
  "policy_version" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "consent_digest" TEXT,
  "consented_by_user_id" UUID,
  "consented_at" TIMESTAMP(3),
  "status" "LocalInferenceBindingStatus" NOT NULL DEFAULT 'pending',
  "reason" TEXT,
  "health_revision" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_local_inference_bindings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_local_inference_bindings_digest_chk" CHECK ("manifest_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "agent_local_inference_bindings_num_ctx_chk" CHECK ("num_ctx" > 0 AND "num_ctx" <= 8192),
  CONSTRAINT "agent_local_inference_bindings_agent_fkey"
    FOREIGN KEY ("organization_id", "agent_id") REFERENCES "agents"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "agent_local_inference_bindings_host_fkey"
    FOREIGN KEY ("organization_id", "host_id") REFERENCES "local_inference_hosts"("organization_id", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "agent_local_inference_bindings_one_active_agent"
  ON "agent_local_inference_bindings"("agent_id") WHERE "status" = 'active';
CREATE INDEX "agent_local_inference_bindings_org_agent_idx" ON "agent_local_inference_bindings"("organization_id", "agent_id");
CREATE INDEX "agent_local_inference_bindings_host_status_idx" ON "agent_local_inference_bindings"("host_id", "status");

CREATE TABLE "local_inference_challenges" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "host_id" UUID NOT NULL,
  "binding_id" UUID NOT NULL,
  "digest" TEXT NOT NULL,
  "subject_digest" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "local_inference_challenges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "local_inference_challenges_digest_key" UNIQUE ("digest")
);
CREATE INDEX "local_inference_challenges_host_expiry_idx" ON "local_inference_challenges"("host_id", "expires_at");

CREATE TABLE "local_inference_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "invocation_id" TEXT NOT NULL,
  "organization_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "host_id" UUID NOT NULL,
  "binding_id" UUID NOT NULL,
  "run_fence" TEXT NOT NULL,
  "host_epoch" INTEGER NOT NULL,
  "dispatch_fence" INTEGER NOT NULL DEFAULT 1,
  "request_digest" TEXT NOT NULL,
  "model_digest" TEXT NOT NULL,
  "state" "LocalInferenceAttemptState" NOT NULL DEFAULT 'queued',
  "lease_expires_at" TIMESTAMP(3),
  "deadline_at" TIMESTAMP(3) NOT NULL,
  "accepted_at" TIMESTAMP(3),
  "terminal_at" TIMESTAMP(3),
  "encrypted_request" BYTEA,
  "encrypted_result" BYTEA,
  "result_digest" TEXT,
  "failure_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "local_inference_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "local_inference_attempts_invocation_id_key" UNIQUE ("invocation_id")
);
CREATE INDEX "local_inference_attempts_host_state_deadline_idx" ON "local_inference_attempts"("host_id", "state", "deadline_at");
CREATE INDEX "local_inference_attempts_run_state_idx" ON "local_inference_attempts"("run_id", "state");
CREATE INDEX "local_inference_attempts_terminal_idx" ON "local_inference_attempts"("terminal_at");

CREATE TABLE "local_inference_frames" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "attempt_id" UUID NOT NULL,
  "dispatch_fence" INTEGER NOT NULL,
  "sequence" INTEGER NOT NULL,
  "encrypted_data" BYTEA NOT NULL,
  "digest" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "local_inference_frames_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "local_inference_frames_attempt_fence_sequence_key"
    UNIQUE ("attempt_id", "dispatch_fence", "sequence")
);
CREATE INDEX "local_inference_frames_attempt_created_idx" ON "local_inference_frames"("attempt_id", "created_at");

ALTER TABLE "agents" ADD COLUMN "local_inference_binding_id" UUID;
CREATE INDEX "agents_local_inference_binding_idx" ON "agents"("local_inference_binding_id");
ALTER TABLE "runs"
  ADD COLUMN "local_inference_binding_id" UUID,
  ADD COLUMN "local_inference_binding_revision" INTEGER,
  ADD COLUMN "local_inference_host_id" UUID,
  ADD COLUMN "local_inference_model_digest" TEXT,
  ADD COLUMN "local_inference_host_epoch" INTEGER;
ALTER TABLE "token_ledger_events"
  ADD COLUMN "local_inference_host_id" UUID,
  ADD COLUMN "local_inference_binding_id" UUID;
CREATE INDEX "token_ledger_events_local_inference_host_idx" ON "token_ledger_events"("local_inference_host_id");
CREATE INDEX "token_ledger_events_local_inference_binding_idx" ON "token_ledger_events"("local_inference_binding_id");

ALTER TABLE "user_alerts"
  ADD COLUMN "local_inference_host_id" UUID,
  ADD COLUMN "local_inference_binding_id" UUID;
CREATE INDEX "user_alerts_local_inference_host_idx" ON "user_alerts"("local_inference_host_id");
CREATE INDEX "user_alerts_local_inference_binding_idx" ON "user_alerts"("local_inference_binding_id");
