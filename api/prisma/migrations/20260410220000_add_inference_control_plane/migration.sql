CREATE TYPE "InferenceConnectorKind" AS ENUM ('compiled', 'openai-compatible');
CREATE TYPE "InferenceLifecycleStatus" AS ENUM ('draft', 'approved', 'deprecated');
CREATE TYPE "InferenceHealthStatus" AS ENUM ('healthy', 'degraded', 'unreachable', 'unknown');
CREATE TYPE "InferenceCapabilitySource" AS ENUM ('static', 'live', 'manual');
CREATE TYPE "InferenceExposure" AS ENUM ('standard', 'admin-only');
CREATE TYPE "InferenceRoutingMode" AS ENUM ('single', 'fallback', 'committee', 'pipeline', 'shadow');
CREATE TYPE "InferenceStageRole" AS ENUM ('advisor', 'executor', 'synthesizer', 'judge', 'shadow');
CREATE TYPE "InferenceStreamPolicy" AS ENUM ('primary-only', 'buffered-judge');
CREATE TYPE "InferenceEvalStatus" AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled');

CREATE TABLE "inference_providers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "provider_key" TEXT NOT NULL,
  "connector_kind" "InferenceConnectorKind" NOT NULL,
  "display_name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "lifecycle_status" "InferenceLifecycleStatus" NOT NULL DEFAULT 'draft',
  "base_url" TEXT,
  "supports_model_discovery" BOOLEAN NOT NULL DEFAULT true,
  "active_credential_binding_id" UUID,
  "health_status" "InferenceHealthStatus" NOT NULL DEFAULT 'unknown',
  "last_checked_at" TIMESTAMP(3),
  "created_by_actor_id" TEXT NOT NULL,
  "updated_by_actor_id" TEXT NOT NULL,
  "approved_by_actor_id" TEXT,
  "approved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inference_providers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inference_credential_bindings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "provider_id" UUID NOT NULL,
  "label" TEXT NOT NULL,
  "auth_secret_ref" TEXT NOT NULL,
  "created_by_actor_id" TEXT NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inference_credential_bindings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inference_models" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "provider_id" UUID NOT NULL,
  "model" TEXT NOT NULL,
  "display_name" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "lifecycle_status" "InferenceLifecycleStatus" NOT NULL DEFAULT 'draft',
  "capability_snapshot_json" JSONB NOT NULL DEFAULT '{}',
  "source" "InferenceCapabilitySource" NOT NULL DEFAULT 'static',
  "discovered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_verified_at" TIMESTAMP(3),
  "created_by_actor_id" TEXT NOT NULL,
  "updated_by_actor_id" TEXT NOT NULL,
  "approved_by_actor_id" TEXT,
  "approved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inference_models_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inference_capability_overrides" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "provider_id" UUID NOT NULL,
  "model" TEXT NOT NULL,
  "lifecycle_status" "InferenceLifecycleStatus" NOT NULL DEFAULT 'draft',
  "override_snapshot_json" JSONB NOT NULL DEFAULT '{}',
  "created_by_actor_id" TEXT NOT NULL,
  "updated_by_actor_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cleared_at" TIMESTAMP(3),
  "approved_by_actor_id" TEXT,
  "approved_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inference_capability_overrides_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tool_mediator_profiles" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "label" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "lifecycle_status" "InferenceLifecycleStatus" NOT NULL DEFAULT 'draft',
  "translator_provider" TEXT NOT NULL,
  "translator_model" TEXT NOT NULL,
  "mediator_config_json" JSONB NOT NULL DEFAULT '{}',
  "created_by_actor_id" TEXT NOT NULL,
  "updated_by_actor_id" TEXT NOT NULL,
  "approved_by_actor_id" TEXT,
  "approved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tool_mediator_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inference_routing_profiles" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "label" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "exposure" "InferenceExposure" NOT NULL DEFAULT 'standard',
  "lifecycle_status" "InferenceLifecycleStatus" NOT NULL DEFAULT 'draft',
  "mode" "InferenceRoutingMode" NOT NULL,
  "stream_policy" "InferenceStreamPolicy" NOT NULL DEFAULT 'primary-only',
  "tool_mediator_profile_id" UUID,
  "route_graph_json" JSONB NOT NULL DEFAULT '{}',
  "created_by_actor_id" TEXT NOT NULL,
  "updated_by_actor_id" TEXT NOT NULL,
  "approved_by_actor_id" TEXT,
  "approved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inference_routing_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inference_eval_suites" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "label" TEXT NOT NULL,
  "exposure" "InferenceExposure" NOT NULL DEFAULT 'standard',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "dataset_ref_json" JSONB NOT NULL DEFAULT '{}',
  "target_routing_profile_id" UUID NOT NULL,
  "judge_routing_profile_id" UUID,
  "lifecycle_status" "InferenceLifecycleStatus" NOT NULL DEFAULT 'draft',
  "created_by_actor_id" TEXT NOT NULL,
  "updated_by_actor_id" TEXT NOT NULL,
  "approved_by_actor_id" TEXT,
  "approved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inference_eval_suites_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inference_eval_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "eval_suite_id" UUID NOT NULL,
  "started_by_actor_id" TEXT NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  "status" "InferenceEvalStatus" NOT NULL DEFAULT 'queued',
  "summary_json" JSONB NOT NULL DEFAULT '{}',
  "result_json" JSONB NOT NULL DEFAULT '{}',
  "case_results_json" JSONB NOT NULL DEFAULT '[]',
  "target_profile_snapshot_json" JSONB NOT NULL DEFAULT '{}',
  "judge_profile_snapshot_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inference_eval_runs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "agents"
  ADD COLUMN "routing_profile_id" UUID;

CREATE UNIQUE INDEX "inference_providers_active_credential_binding_id_key"
  ON "inference_providers"("active_credential_binding_id");
CREATE UNIQUE INDEX "inference_credential_bindings_provider_id_label_key"
  ON "inference_credential_bindings"("provider_id", "label");
CREATE UNIQUE INDEX "inference_models_provider_id_model_key"
  ON "inference_models"("provider_id", "model");
CREATE UNIQUE INDEX "inference_capability_overrides_provider_id_model_key"
  ON "inference_capability_overrides"("provider_id", "model");
CREATE UNIQUE INDEX "tool_mediator_profiles_organization_id_label_key"
  ON "tool_mediator_profiles"("organization_id", "label");
CREATE UNIQUE INDEX "inference_routing_profiles_organization_id_label_key"
  ON "inference_routing_profiles"("organization_id", "label");
CREATE UNIQUE INDEX "inference_eval_suites_organization_id_label_key"
  ON "inference_eval_suites"("organization_id", "label");

CREATE INDEX "inference_providers_organization_id_provider_key_idx"
  ON "inference_providers"("organization_id", "provider_key");
CREATE INDEX "inference_providers_organization_id_enabled_lifecycle_status_idx"
  ON "inference_providers"("organization_id", "enabled", "lifecycle_status");
CREATE INDEX "inference_providers_organization_id_health_status_idx"
  ON "inference_providers"("organization_id", "health_status");
CREATE INDEX "inference_credential_bindings_organization_id_provider_id_created_at_idx"
  ON "inference_credential_bindings"("organization_id", "provider_id", "created_at" DESC);
CREATE INDEX "inference_models_organization_id_provider_id_enabled_lifecycle_status_idx"
  ON "inference_models"("organization_id", "provider_id", "enabled", "lifecycle_status");
CREATE INDEX "inference_capability_overrides_organization_id_provider_id_lifecycle_status_idx"
  ON "inference_capability_overrides"("organization_id", "provider_id", "lifecycle_status");
CREATE INDEX "tool_mediator_profiles_organization_id_enabled_lifecycle_status_idx"
  ON "tool_mediator_profiles"("organization_id", "enabled", "lifecycle_status");
CREATE INDEX "inference_routing_profiles_organization_id_enabled_lifecycle_status_idx"
  ON "inference_routing_profiles"("organization_id", "enabled", "lifecycle_status");
CREATE INDEX "inference_routing_profiles_organization_id_exposure_lifecycle_status_idx"
  ON "inference_routing_profiles"("organization_id", "exposure", "lifecycle_status");
CREATE INDEX "inference_eval_suites_organization_id_enabled_lifecycle_status_idx"
  ON "inference_eval_suites"("organization_id", "enabled", "lifecycle_status");
CREATE INDEX "inference_eval_suites_organization_id_exposure_lifecycle_status_idx"
  ON "inference_eval_suites"("organization_id", "exposure", "lifecycle_status");
CREATE INDEX "inference_eval_runs_organization_id_status_started_at_idx"
  ON "inference_eval_runs"("organization_id", "status", "started_at" DESC);
CREATE INDEX "inference_eval_runs_eval_suite_id_started_at_idx"
  ON "inference_eval_runs"("eval_suite_id", "started_at" DESC);
CREATE INDEX "agents_routing_profile_id_idx"
  ON "agents"("routing_profile_id");

ALTER TABLE "inference_providers"
  ADD CONSTRAINT "inference_providers_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "inference_providers_active_credential_binding_id_fkey"
    FOREIGN KEY ("active_credential_binding_id") REFERENCES "inference_credential_bindings"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inference_credential_bindings"
  ADD CONSTRAINT "inference_credential_bindings_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "inference_credential_bindings_provider_id_fkey"
    FOREIGN KEY ("provider_id") REFERENCES "inference_providers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inference_models"
  ADD CONSTRAINT "inference_models_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "inference_models_provider_id_fkey"
    FOREIGN KEY ("provider_id") REFERENCES "inference_providers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inference_capability_overrides"
  ADD CONSTRAINT "inference_capability_overrides_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "inference_capability_overrides_provider_id_fkey"
    FOREIGN KEY ("provider_id") REFERENCES "inference_providers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tool_mediator_profiles"
  ADD CONSTRAINT "tool_mediator_profiles_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inference_routing_profiles"
  ADD CONSTRAINT "inference_routing_profiles_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "inference_routing_profiles_tool_mediator_profile_id_fkey"
    FOREIGN KEY ("tool_mediator_profile_id") REFERENCES "tool_mediator_profiles"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inference_eval_suites"
  ADD CONSTRAINT "inference_eval_suites_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "inference_eval_suites_target_routing_profile_id_fkey"
    FOREIGN KEY ("target_routing_profile_id") REFERENCES "inference_routing_profiles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "inference_eval_suites_judge_routing_profile_id_fkey"
    FOREIGN KEY ("judge_routing_profile_id") REFERENCES "inference_routing_profiles"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inference_eval_runs"
  ADD CONSTRAINT "inference_eval_runs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "inference_eval_runs_eval_suite_id_fkey"
    FOREIGN KEY ("eval_suite_id") REFERENCES "inference_eval_suites"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agents"
  ADD CONSTRAINT "agents_routing_profile_id_fkey"
    FOREIGN KEY ("routing_profile_id") REFERENCES "inference_routing_profiles"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
