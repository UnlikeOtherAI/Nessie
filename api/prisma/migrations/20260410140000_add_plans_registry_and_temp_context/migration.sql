-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('draft', 'active', 'waiting', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "PlanStepStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'skipped', 'blocked');

-- CreateEnum
CREATE TYPE "MailboxMessageStatus" AS ENUM ('queued', 'processing', 'delivered', 'dead_letter');

-- CreateEnum
CREATE TYPE "ResourceLockType" AS ENUM ('exclusive', 'shared');

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID,
    "team_id" UUID,
    "channel_id" UUID,
    "run_id" UUID,
    "agent_id" UUID,
    "goal" TEXT NOT NULL,
    "summary" TEXT,
    "status" "PlanStatus" NOT NULL DEFAULT 'draft',
    "created_by_actor_type" TEXT NOT NULL,
    "created_by_actor_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_steps" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "assigned_agent_id" UUID,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "PlanStepStatus" NOT NULL DEFAULT 'pending',
    "payload" JSONB DEFAULT '{}',
    "artifacts" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_mailbox_messages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plan_id" UUID,
    "plan_step_id" UUID,
    "from_agent_id" UUID,
    "to_agent_id" UUID,
    "channel_id" UUID,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "correlation_id" TEXT,
    "status" "MailboxMessageStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "visible_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_mailbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_locks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plan_id" UUID,
    "run_id" UUID,
    "agent_id" UUID NOT NULL,
    "resource_path" TEXT NOT NULL,
    "lock_type" "ResourceLockType" NOT NULL DEFAULT 'exclusive',
    "acquired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "released_at" TIMESTAMP(3),

    CONSTRAINT "resource_locks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_registry_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "tool_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "safe" BOOLEAN NOT NULL DEFAULT false,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "handler_kind" TEXT NOT NULL DEFAULT 'builtin',
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_registry_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "temporary_context_sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "agent_id" UUID,
    "run_id" UUID,
    "thread_id" UUID,
    "title" TEXT,
    "tool_ids" JSONB NOT NULL DEFAULT '[]',
    "created_by_actor_type" TEXT NOT NULL,
    "created_by_actor_id" TEXT NOT NULL,
    "dropped_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "temporary_context_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plans_organization_id_created_at_idx" ON "plans"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "plans_organization_id_status_created_at_idx" ON "plans"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "plans_agent_id_status_idx" ON "plans"("agent_id", "status");

-- CreateIndex
CREATE INDEX "plan_steps_plan_id_sequence_idx" ON "plan_steps"("plan_id", "sequence");

-- CreateIndex
CREATE INDEX "plan_steps_assigned_agent_id_status_idx" ON "plan_steps"("assigned_agent_id", "status");

-- CreateIndex
CREATE INDEX "agent_mailbox_messages_organization_id_status_visible_at_idx" ON "agent_mailbox_messages"("organization_id", "status", "visible_at");

-- CreateIndex
CREATE INDEX "agent_mailbox_messages_to_agent_id_status_visible_at_idx" ON "agent_mailbox_messages"("to_agent_id", "status", "visible_at");

-- CreateIndex
CREATE INDEX "agent_mailbox_messages_plan_id_created_at_idx" ON "agent_mailbox_messages"("plan_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_mailbox_messages_to_agent_id_correlation_id_key" ON "agent_mailbox_messages"("to_agent_id", "correlation_id");

-- CreateIndex
CREATE INDEX "resource_locks_organization_id_resource_path_released_at_idx" ON "resource_locks"("organization_id", "resource_path", "released_at");

-- CreateIndex
CREATE INDEX "resource_locks_agent_id_released_at_idx" ON "resource_locks"("agent_id", "released_at");

-- CreateIndex
CREATE UNIQUE INDEX "tool_registry_entries_tool_id_key" ON "tool_registry_entries"("tool_id");

-- CreateIndex
CREATE INDEX "tool_registry_entries_organization_id_enabled_idx" ON "tool_registry_entries"("organization_id", "enabled");

-- CreateIndex
CREATE INDEX "tool_registry_entries_builtin_enabled_idx" ON "tool_registry_entries"("builtin", "enabled");

-- CreateIndex
CREATE INDEX "temporary_context_sessions_organization_id_dropped_at_created_at_idx" ON "temporary_context_sessions"("organization_id", "dropped_at", "created_at");

-- CreateIndex
CREATE INDEX "temporary_context_sessions_agent_id_dropped_at_idx" ON "temporary_context_sessions"("agent_id", "dropped_at");

-- CreateIndex
CREATE INDEX "temporary_context_sessions_run_id_dropped_at_idx" ON "temporary_context_sessions"("run_id", "dropped_at");

-- CreateIndex
CREATE INDEX "temporary_context_sessions_thread_id_dropped_at_idx" ON "temporary_context_sessions"("thread_id", "dropped_at");
