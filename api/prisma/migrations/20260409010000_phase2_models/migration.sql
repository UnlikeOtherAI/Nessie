-- Phase 2 Models Migration

-- New enums
CREATE TYPE "PolicyScope" AS ENUM ('organization', 'project', 'team', 'channel', 'agent', 'tool', 'user');
CREATE TYPE "PolicyResourceType" AS ENUM ('agent', 'channel', 'project', 'tool', 'session', 'task', 'review', 'approval', 'admin', 'secret');
CREATE TYPE "PolicyAction" AS ENUM ('view', 'invoke', 'create', 'edit', 'assign', 'approve', 'review', 'search', 'export', 'admin', 'resolve', 'rotate', 'revoke', 'bind', 'link', 'reindex', 'summarize', 'read', 'import', 'grant', 'enroll', 'challenge');
CREATE TYPE "PolicyEffect" AS ENUM ('allow', 'deny');
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected', 'expired');
CREATE TYPE "AuditActorType" AS ENUM ('user', 'agent', 'service', 'system');
CREATE TYPE "AuditOutcome" AS ENUM ('success', 'denied', 'error');
CREATE TYPE "PricingSource" AS ENUM ('provider-default', 'org-override', 'team-override', 'manual');
CREATE TYPE "OperationType" AS ENUM ('chat', 'completion', 'embedding', 'translation', 'reasoning', 'tool-translation', 'other');

-- Add waiting_approval to RunStatus
ALTER TYPE "RunStatus" ADD VALUE 'waiting_approval';

-- Add ownership fields to agents
ALTER TABLE "agents" ADD COLUMN "organization_id" UUID;
ALTER TABLE "agents" ADD COLUMN "project_id" UUID;
ALTER TABLE "agents" ADD COLUMN "team_id" UUID;
CREATE INDEX "agents_organization_id_idx" ON "agents"("organization_id");
CREATE INDEX "agents_organization_id_project_id_idx" ON "agents"("organization_id", "project_id");

-- PolicyRule
CREATE TABLE "policy_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "scope" "PolicyScope" NOT NULL,
    "scope_id" TEXT NOT NULL,
    "resource_type" "PolicyResourceType" NOT NULL,
    "action" "PolicyAction" NOT NULL,
    "effect" "PolicyEffect" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "conditions" JSONB,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "policy_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "policy_rules_organization_id_scope_resource_type_idx" ON "policy_rules"("organization_id", "scope", "resource_type");
CREATE INDEX "policy_rules_organization_id_scope_id_idx" ON "policy_rules"("organization_id", "scope_id");

-- PolicyBinding
CREATE TABLE "policy_bindings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "policy_rule_id" UUID NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    CONSTRAINT "policy_bindings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "policy_bindings_policy_rule_id_fkey" FOREIGN KEY ("policy_rule_id") REFERENCES "policy_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "policy_bindings_policy_rule_id_actor_type_actor_id_key" ON "policy_bindings"("policy_rule_id", "actor_type", "actor_id");
CREATE INDEX "policy_bindings_actor_type_actor_id_idx" ON "policy_bindings"("actor_type", "actor_id");

-- ApprovalRequest
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "project_id" UUID,
    "team_id" UUID,
    "channel_id" UUID,
    "task_id" UUID,
    "run_id" UUID,
    "agent_id" UUID NOT NULL,
    "requester_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "context" JSONB,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "resolver_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolution" TEXT,
    "resolution_note" TEXT,
    "continuation_token" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_requests_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "approval_requests_organization_id_status_idx" ON "approval_requests"("organization_id", "status");
CREATE INDEX "approval_requests_agent_id_status_idx" ON "approval_requests"("agent_id", "status");
CREATE INDEX "approval_requests_status_expires_at_idx" ON "approval_requests"("status", "expires_at");

-- AuditLog
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "project_id" UUID,
    "team_id" UUID,
    "channel_id" UUID,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "outcome" "AuditOutcome" NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "request_id" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at" DESC);
CREATE INDEX "audit_logs_organization_id_action_created_at_idx" ON "audit_logs"("organization_id", "action", "created_at" DESC);
CREATE INDEX "audit_logs_organization_id_actor_id_created_at_idx" ON "audit_logs"("organization_id", "actor_id", "created_at" DESC);
CREATE INDEX "audit_logs_organization_id_resource_type_resource_id_idx" ON "audit_logs"("organization_id", "resource_type", "resource_id");

-- TokenLedgerEvent
CREATE TABLE "token_ledger_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID,
    "team_id" UUID,
    "channel_id" UUID,
    "thread_id" UUID,
    "session_id" TEXT,
    "task_id" UUID,
    "agent_id" UUID,
    "actor_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "correlation_id" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "operation_type" "OperationType" NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cached_input_tokens" INTEGER,
    "cached_output_tokens" INTEGER,
    "cache_read_tokens" INTEGER,
    "cache_write_tokens" INTEGER,
    "total_tokens" INTEGER,
    "provider_cost_amount" DOUBLE PRECISION,
    "provider_cost_currency" TEXT,
    "pricing_profile_id" UUID,
    "pricing_source" "PricingSource",
    "pricing_currency" TEXT,
    "pricing_input_per_m" DOUBLE PRECISION,
    "pricing_output_per_m" DOUBLE PRECISION,
    "estimated_cost_amount" DOUBLE PRECISION,
    "estimated_cost_currency" TEXT,
    "metadata" JSONB,
    CONSTRAINT "token_ledger_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "token_ledger_events_org_occurred_idx" ON "token_ledger_events"("organization_id", "occurred_at" DESC);
CREATE INDEX "token_ledger_events_org_provider_model_idx" ON "token_ledger_events"("organization_id", "provider", "model", "occurred_at" DESC);
CREATE INDEX "token_ledger_events_org_agent_idx" ON "token_ledger_events"("organization_id", "agent_id", "occurred_at" DESC);
CREATE INDEX "token_ledger_events_org_actor_idx" ON "token_ledger_events"("organization_id", "actor_id", "occurred_at" DESC);

-- ModelPricingProfile
CREATE TABLE "model_pricing_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model_pattern" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "source" "PricingSource" NOT NULL,
    "input_per_million" DOUBLE PRECISION,
    "output_per_million" DOUBLE PRECISION,
    "cached_input_per_million" DOUBLE PRECISION,
    "cached_output_per_million" DOUBLE PRECISION,
    "cache_read_per_million" DOUBLE PRECISION,
    "cache_write_per_million" DOUBLE PRECISION,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "effective_to" TIMESTAMPTZ(6),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "model_pricing_profiles_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "model_pricing_profiles_org_provider_model_idx" ON "model_pricing_profiles"("organization_id", "provider", "model_pattern");
