-- DropForeignKey
ALTER TABLE "inference_capability_overrides" DROP CONSTRAINT IF EXISTS "inference_capability_overrides_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "inference_credential_bindings" DROP CONSTRAINT IF EXISTS "inference_credential_bindings_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "inference_eval_runs" DROP CONSTRAINT IF EXISTS "inference_eval_runs_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "inference_eval_suites" DROP CONSTRAINT IF EXISTS "inference_eval_suites_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "inference_models" DROP CONSTRAINT IF EXISTS "inference_models_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "inference_providers" DROP CONSTRAINT IF EXISTS "inference_providers_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "inference_routing_profiles" DROP CONSTRAINT IF EXISTS "inference_routing_profiles_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "thought_recalls" DROP CONSTRAINT IF EXISTS "thought_recalls_thought_id_fkey";

-- DropForeignKey
ALTER TABLE "thread_stream_events" DROP CONSTRAINT IF EXISTS "thread_stream_events_thread_id_fkey";

-- DropForeignKey
ALTER TABLE "tool_mediator_profiles" DROP CONSTRAINT IF EXISTS "tool_mediator_profiles_organization_id_fkey";

-- DropIndex
DROP INDEX IF EXISTS "channels_system_channel_type_idx";

-- DropIndex
DROP INDEX IF EXISTS "plans_organization_id_created_at_idx";

-- DropIndex
DROP INDEX IF EXISTS "plans_organization_id_status_created_at_idx";

-- DropIndex
DROP INDEX IF EXISTS "teams_project_id_system_managed_idx";

-- DropIndex
DROP INDEX IF EXISTS "temporary_context_sessions_organization_id_dropped_at_created_a";

-- DropIndex
DROP INDEX IF EXISTS "idx_thoughts_embedding";

-- DropIndex
DROP INDEX IF EXISTS "idx_thoughts_metadata";

-- DropIndex
DROP INDEX IF EXISTS "idx_thoughts_search_vector";

-- DropIndex
DROP INDEX IF EXISTS "tool_registry_entries_tool_id_key";

-- AlterTable
ALTER TABLE "agent_trigger_deliveries" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "agent_triggers" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "approval_requests" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "audit_logs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "call_participants" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "calls" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "execution_environment_instances" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "execution_environment_templates" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "execution_leases" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "execution_runners" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "execution_usage_ledger" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "inference_capability_overrides" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "inference_credential_bindings" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "inference_eval_runs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "inference_eval_suites" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "dataset_ref_json" DROP DEFAULT;

-- AlterTable
ALTER TABLE "inference_models" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "inference_providers" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "inference_routing_profiles" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "message_reactions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "model_pricing_profiles" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "policy_bindings" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "policy_rules" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "thought_audit_logs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "thought_links" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "thought_reasonings" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "thought_recalls" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
-- NOTE: `search_vector` is a STORED GENERATED column
-- (to_tsvector('english'::regconfig, COALESCE(content, ''::text))).
-- The generation expression is now declared on the Prisma model via
-- @default(dbgenerated(...)) so prisma migrate diff stays clean.
ALTER TABLE "thoughts" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "token_ledger_events" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tool_mediator_profiles" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "workflow_installations" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "workflow_runs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "workflow_state_entries" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "workflow_step_runs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "workflow_templates" ALTER COLUMN "id" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "plans_organization_id_created_at_idx" ON "plans"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "plans_organization_id_status_created_at_idx" ON "plans"("organization_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "temporary_context_sessions_organization_id_dropped_at_creat_idx" ON "temporary_context_sessions"("organization_id", "dropped_at", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "thread_stream_events" ADD CONSTRAINT "thread_stream_events_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thought_recalls" ADD CONSTRAINT "thought_recalls_thought_id_fkey" FOREIGN KEY ("thought_id") REFERENCES "thoughts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "agent_triggers_type_enabled_status_next_run_at_scheduler_claime" RENAME TO "agent_triggers_type_enabled_status_next_run_at_scheduler_cl_idx";

-- RenameIndex
ALTER INDEX "execution_environment_instances_organization_id_status_created_" RENAME TO "execution_environment_instances_organization_id_status_crea_idx";

-- RenameIndex
ALTER INDEX "execution_environment_templates_organization_id_enabled_created" RENAME TO "execution_environment_templates_organization_id_enabled_cre_idx";

-- RenameIndex
ALTER INDEX "execution_environment_templates_organization_id_provider_mode_i" RENAME TO "execution_environment_templates_organization_id_provider_mo_idx";

-- RenameIndex
ALTER INDEX "inference_capability_overrides_organization_id_provider_id_life" RENAME TO "inference_capability_overrides_organization_id_provider_id__idx";

-- RenameIndex
ALTER INDEX "inference_credential_bindings_organization_id_provider_id_creat" RENAME TO "inference_credential_bindings_organization_id_provider_id_c_idx";

-- RenameIndex
ALTER INDEX "inference_eval_suites_organization_id_enabled_lifecycle_status_" RENAME TO "inference_eval_suites_organization_id_enabled_lifecycle_sta_idx";

-- RenameIndex
ALTER INDEX "inference_eval_suites_organization_id_exposure_lifecycle_status" RENAME TO "inference_eval_suites_organization_id_exposure_lifecycle_st_idx";

-- RenameIndex
ALTER INDEX "inference_models_organization_id_provider_id_enabled_lifecycle_" RENAME TO "inference_models_organization_id_provider_id_enabled_lifecy_idx";

-- RenameIndex
ALTER INDEX "inference_providers_organization_id_enabled_lifecycle_status_id" RENAME TO "inference_providers_organization_id_enabled_lifecycle_statu_idx";

-- RenameIndex
ALTER INDEX "inference_routing_profiles_organization_id_enabled_lifecycle_st" RENAME TO "inference_routing_profiles_organization_id_enabled_lifecycl_idx";

-- RenameIndex
ALTER INDEX "inference_routing_profiles_organization_id_exposure_lifecycle_s" RENAME TO "inference_routing_profiles_organization_id_exposure_lifecyc_idx";

-- RenameIndex
ALTER INDEX "model_pricing_profiles_org_provider_model_idx" RENAME TO "model_pricing_profiles_organization_id_provider_model_patte_idx";

-- RenameIndex
ALTER INDEX "thought_recalls_output_audience_type_output_audience_id_created" RENAME TO "thought_recalls_output_audience_type_output_audience_id_cre_idx";

-- RenameIndex
ALTER INDEX "thought_recalls_session_idx" RENAME TO "thought_recalls_session_id_created_at_idx";

-- RenameIndex
ALTER INDEX "thoughts_organization_id_audience_type_audience_id_created_at_i" RENAME TO "thoughts_organization_id_audience_type_audience_id_created__idx";

-- RenameIndex
ALTER INDEX "idx_threads_channel_created" RENAME TO "threads_channel_id_created_at_idx";

-- RenameIndex
ALTER INDEX "token_ledger_events_org_actor_idx" RENAME TO "token_ledger_events_organization_id_actor_id_occurred_at_idx";

-- RenameIndex
ALTER INDEX "token_ledger_events_org_agent_idx" RENAME TO "token_ledger_events_organization_id_agent_id_occurred_at_idx";

-- RenameIndex
ALTER INDEX "token_ledger_events_org_occurred_idx" RENAME TO "token_ledger_events_organization_id_occurred_at_idx";

-- RenameIndex
ALTER INDEX "token_ledger_events_org_provider_model_idx" RENAME TO "token_ledger_events_organization_id_provider_model_occurred_idx";

-- RenameIndex
ALTER INDEX "tool_mediator_profiles_organization_id_enabled_lifecycle_status" RENAME TO "tool_mediator_profiles_organization_id_enabled_lifecycle_st_idx";

-- RenameIndex
ALTER INDEX "workflow_state_entries_workflow_installation_id_key_key" RENAME TO "workflow_state_entries_workflow_installation_id_state_key_key";

