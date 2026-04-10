CREATE TYPE "WorkflowInstallationStatus" AS ENUM ('draft', 'active', 'paused', 'disabled');
CREATE TYPE "WorkflowRunStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');
CREATE TYPE "WorkflowStepRunStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'skipped', 'blocked');
CREATE TYPE "ExecutionProvider" AS ENUM ('docker', 'gcloud');
CREATE TYPE "ExecutionMode" AS ENUM ('container', 'vm', 'function');
CREATE TYPE "ExecutionEnvironmentInstanceStatus" AS ENUM ('pending', 'provisioning', 'ready', 'failed', 'terminated');
CREATE TYPE "ExecutionRunnerStatus" AS ENUM ('active', 'draining', 'offline');
CREATE TYPE "ExecutionLeaseStatus" AS ENUM ('issued', 'acknowledged', 'completed', 'revoked', 'expired');

ALTER TABLE "agent_mailbox_messages"
  ADD COLUMN "workflow_run_id" UUID,
  ADD COLUMN "workflow_step_run_id" UUID;

CREATE TABLE "workflow_templates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "graph_json" JSONB NOT NULL DEFAULT '{}',
  "triggers_json" JSONB NOT NULL DEFAULT '{}',
  "variable_schema" JSONB NOT NULL DEFAULT '{}',
  "binding_schema" JSONB NOT NULL DEFAULT '{}',
  "required_environment_template_ids" JSONB NOT NULL DEFAULT '[]',
  "created_by_actor_type" TEXT NOT NULL,
  "created_by_actor_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "workflow_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_installations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workflow_template_id" UUID NOT NULL,
  "workflow_template_version" INTEGER NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID,
  "team_id" UUID,
  "channel_id" UUID,
  "status" "WorkflowInstallationStatus" NOT NULL DEFAULT 'draft',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "resolved_bindings" JSONB NOT NULL DEFAULT '{}',
  "config" JSONB NOT NULL DEFAULT '{}',
  "created_by_actor_type" TEXT NOT NULL,
  "created_by_actor_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "workflow_installations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "installation_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "trigger_id" UUID,
  "trigger_delivery_id" UUID,
  "parent_run_id" UUID,
  "plan_id" UUID,
  "plan_step_id" UUID,
  "status" "WorkflowRunStatus" NOT NULL DEFAULT 'pending',
  "input" JSONB NOT NULL DEFAULT '{}',
  "output" JSONB DEFAULT '{}',
  "summary" TEXT,
  "error_message" TEXT,
  "started_by_actor_type" TEXT NOT NULL,
  "started_by_actor_id" TEXT NOT NULL,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_step_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workflow_run_id" UUID NOT NULL,
  "step_key" TEXT NOT NULL,
  "step_type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "status" "WorkflowStepRunStatus" NOT NULL DEFAULT 'pending',
  "input" JSONB NOT NULL DEFAULT '{}',
  "output" JSONB DEFAULT '{}',
  "error_message" TEXT,
  "assigned_agent_id" UUID,
  "agent_run_id" UUID,
  "task_id" UUID,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "workflow_step_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "execution_environment_templates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "project_id" UUID,
  "team_id" UUID,
  "channel_id" UUID,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "provider" "ExecutionProvider" NOT NULL,
  "mode" "ExecutionMode" NOT NULL,
  "image" TEXT,
  "launch_config" JSONB NOT NULL DEFAULT '{}',
  "pricing_config" JSONB NOT NULL DEFAULT '{}',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_by_actor_type" TEXT NOT NULL,
  "created_by_actor_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "execution_environment_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "execution_environment_instances" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "template_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID,
  "team_id" UUID,
  "channel_id" UUID,
  "workflow_run_id" UUID,
  "workflow_step_run_id" UUID,
  "run_id" UUID,
  "agent_id" UUID,
  "status" "ExecutionEnvironmentInstanceStatus" NOT NULL DEFAULT 'pending',
  "launched_by_actor_type" TEXT NOT NULL,
  "launched_by_actor_id" TEXT NOT NULL,
  "provider_instance_ref" TEXT,
  "launch_config" JSONB NOT NULL DEFAULT '{}',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "error_message" TEXT,
  "started_at" TIMESTAMP(3),
  "ready_at" TIMESTAMP(3),
  "terminated_at" TIMESTAMP(3),
  "last_heartbeat_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "execution_environment_instances_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "execution_runners" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID,
  "provider" "ExecutionProvider" NOT NULL,
  "label" TEXT NOT NULL,
  "capabilities" JSONB NOT NULL DEFAULT '{}',
  "status" "ExecutionRunnerStatus" NOT NULL DEFAULT 'active',
  "heartbeat_at" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "execution_runners_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "execution_leases" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "instance_id" UUID NOT NULL,
  "runner_id" UUID NOT NULL,
  "status" "ExecutionLeaseStatus" NOT NULL DEFAULT 'issued',
  "lease_token" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "acknowledged_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "execution_leases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "execution_usage_ledger" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "instance_id" UUID NOT NULL,
  "template_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID,
  "team_id" UUID,
  "channel_id" UUID,
  "workflow_run_id" UUID,
  "workflow_step_run_id" UUID,
  "run_id" UUID,
  "agent_id" UUID,
  "actor_type" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "meter_type" TEXT NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  "unit_price" DOUBLE PRECISION,
  "cost_amount" DOUBLE PRECISION,
  "currency" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "execution_usage_ledger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workflow_step_runs_workflow_run_id_sequence_key"
  ON "workflow_step_runs"("workflow_run_id", "sequence");
CREATE UNIQUE INDEX "execution_environment_instances_workflow_step_run_id_key"
  ON "execution_environment_instances"("workflow_step_run_id");
CREATE UNIQUE INDEX "execution_runners_provider_label_key"
  ON "execution_runners"("provider", "label");
CREATE UNIQUE INDEX "execution_leases_lease_token_key"
  ON "execution_leases"("lease_token");

CREATE INDEX "agent_mailbox_messages_workflow_run_id_created_at_idx"
  ON "agent_mailbox_messages"("workflow_run_id", "created_at");
CREATE INDEX "workflow_templates_organization_id_created_at_idx"
  ON "workflow_templates"("organization_id", "created_at" DESC);
CREATE INDEX "workflow_templates_organization_id_name_idx"
  ON "workflow_templates"("organization_id", "name");
CREATE INDEX "workflow_installations_organization_id_created_at_idx"
  ON "workflow_installations"("organization_id", "created_at" DESC);
CREATE INDEX "workflow_installations_organization_id_status_created_at_idx"
  ON "workflow_installations"("organization_id", "status", "created_at" DESC);
CREATE INDEX "workflow_installations_workflow_template_id_created_at_idx"
  ON "workflow_installations"("workflow_template_id", "created_at" DESC);
CREATE INDEX "workflow_runs_installation_id_created_at_idx"
  ON "workflow_runs"("installation_id", "created_at" DESC);
CREATE INDEX "workflow_runs_organization_id_status_created_at_idx"
  ON "workflow_runs"("organization_id", "status", "created_at" DESC);
CREATE INDEX "workflow_runs_trigger_id_created_at_idx"
  ON "workflow_runs"("trigger_id", "created_at" DESC);
CREATE INDEX "workflow_runs_parent_run_id_created_at_idx"
  ON "workflow_runs"("parent_run_id", "created_at" DESC);
CREATE INDEX "workflow_step_runs_workflow_run_id_status_idx"
  ON "workflow_step_runs"("workflow_run_id", "status");
CREATE INDEX "workflow_step_runs_assigned_agent_id_status_idx"
  ON "workflow_step_runs"("assigned_agent_id", "status");
CREATE INDEX "execution_environment_templates_organization_id_enabled_created_at_idx"
  ON "execution_environment_templates"("organization_id", "enabled", "created_at" DESC);
CREATE INDEX "execution_environment_templates_organization_id_provider_mode_idx"
  ON "execution_environment_templates"("organization_id", "provider", "mode");
CREATE INDEX "execution_environment_instances_organization_id_status_created_at_idx"
  ON "execution_environment_instances"("organization_id", "status", "created_at" DESC);
CREATE INDEX "execution_environment_instances_template_id_created_at_idx"
  ON "execution_environment_instances"("template_id", "created_at" DESC);
CREATE INDEX "execution_environment_instances_workflow_run_id_created_at_idx"
  ON "execution_environment_instances"("workflow_run_id", "created_at" DESC);
CREATE INDEX "execution_runners_organization_id_provider_status_idx"
  ON "execution_runners"("organization_id", "provider", "status");
CREATE INDEX "execution_leases_instance_id_status_created_at_idx"
  ON "execution_leases"("instance_id", "status", "created_at" DESC);
CREATE INDEX "execution_leases_runner_id_status_created_at_idx"
  ON "execution_leases"("runner_id", "status", "created_at" DESC);
CREATE INDEX "execution_usage_ledger_organization_id_recorded_at_idx"
  ON "execution_usage_ledger"("organization_id", "recorded_at" DESC);
CREATE INDEX "execution_usage_ledger_instance_id_recorded_at_idx"
  ON "execution_usage_ledger"("instance_id", "recorded_at" DESC);
CREATE INDEX "execution_usage_ledger_workflow_run_id_recorded_at_idx"
  ON "execution_usage_ledger"("workflow_run_id", "recorded_at" DESC);

ALTER TABLE "workflow_installations"
  ADD CONSTRAINT "workflow_installations_workflow_template_id_fkey"
    FOREIGN KEY ("workflow_template_id") REFERENCES "workflow_templates"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_runs"
  ADD CONSTRAINT "workflow_runs_installation_id_fkey"
    FOREIGN KEY ("installation_id") REFERENCES "workflow_installations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "workflow_runs_trigger_id_fkey"
    FOREIGN KEY ("trigger_id") REFERENCES "agent_triggers"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "workflow_runs_trigger_delivery_id_fkey"
    FOREIGN KEY ("trigger_delivery_id") REFERENCES "agent_trigger_deliveries"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "workflow_runs_parent_run_id_fkey"
    FOREIGN KEY ("parent_run_id") REFERENCES "runs"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "workflow_runs_plan_id_fkey"
    FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "workflow_runs_plan_step_id_fkey"
    FOREIGN KEY ("plan_step_id") REFERENCES "plan_steps"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "workflow_step_runs"
  ADD CONSTRAINT "workflow_step_runs_workflow_run_id_fkey"
    FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "workflow_step_runs_assigned_agent_id_fkey"
    FOREIGN KEY ("assigned_agent_id") REFERENCES "agents"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "workflow_step_runs_agent_run_id_fkey"
    FOREIGN KEY ("agent_run_id") REFERENCES "runs"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "workflow_step_runs_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "execution_environment_instances"
  ADD CONSTRAINT "execution_environment_instances_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "execution_environment_templates"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "execution_environment_instances_workflow_run_id_fkey"
    FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "execution_environment_instances_workflow_step_run_id_fkey"
    FOREIGN KEY ("workflow_step_run_id") REFERENCES "workflow_step_runs"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "execution_environment_instances_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "runs"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "execution_environment_instances_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "execution_leases"
  ADD CONSTRAINT "execution_leases_instance_id_fkey"
    FOREIGN KEY ("instance_id") REFERENCES "execution_environment_instances"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "execution_leases_runner_id_fkey"
    FOREIGN KEY ("runner_id") REFERENCES "execution_runners"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "execution_usage_ledger"
  ADD CONSTRAINT "execution_usage_ledger_instance_id_fkey"
    FOREIGN KEY ("instance_id") REFERENCES "execution_environment_instances"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "execution_usage_ledger_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "execution_environment_templates"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "execution_usage_ledger_workflow_run_id_fkey"
    FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "execution_usage_ledger_workflow_step_run_id_fkey"
    FOREIGN KEY ("workflow_step_run_id") REFERENCES "workflow_step_runs"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
