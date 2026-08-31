-- Per-agent reusable to-do templates, instances, and materialized step state.
-- The composite foreign keys make mismatched tenant/agent and agent/template
-- pairs unrepresentable even for writers outside the service layer.

CREATE TYPE "AgentTodoTemplateStatus" AS ENUM ('draft', 'active', 'archived');

CREATE TYPE "AgentTodoStatus" AS ENUM ('open', 'running', 'completed', 'cancelled');

CREATE TYPE "AgentTodoStepStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'skipped');

CREATE TYPE "AgentTodoActorType" AS ENUM ('user', 'agent');

ALTER TABLE "agents" ADD COLUMN "todos_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "agents_organization_id_id_key" ON "agents"("organization_id", "id");

CREATE TABLE "agent_todo_templates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "steps" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "AgentTodoTemplateStatus" NOT NULL DEFAULT 'draft',
    "author_type" "AgentTodoActorType" NOT NULL,
    "created_by_user_id" UUID,
    "proposed_by_run_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_todo_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_todos" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "template_id" UUID,
    "template_version" INTEGER,
    "title" TEXT NOT NULL,
    "status" "AgentTodoStatus" NOT NULL DEFAULT 'open',
    "created_by_user_id" UUID,
    "trigger_id" UUID,
    "thread_id" UUID,
    "active_run_id" UUID,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_todos_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_todo_steps" (
    "id" UUID NOT NULL,
    "todo_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "status" "AgentTodoStepStatus" NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "updated_by_actor_type" "AgentTodoActorType",
    "updated_by_actor_id" UUID,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "agent_todo_steps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_todo_templates_agent_id_id_key"
  ON "agent_todo_templates"("agent_id", "id");
CREATE INDEX "agent_todo_templates_organization_id_agent_id_status_idx"
  ON "agent_todo_templates"("organization_id", "agent_id", "status");
CREATE INDEX "agent_todo_templates_created_by_user_id_idx"
  ON "agent_todo_templates"("created_by_user_id");
CREATE INDEX "agent_todo_templates_proposed_by_run_id_idx"
  ON "agent_todo_templates"("proposed_by_run_id");

CREATE INDEX "agent_todos_organization_id_agent_id_status_idx"
  ON "agent_todos"("organization_id", "agent_id", "status");
CREATE INDEX "agent_todos_agent_id_template_id_idx"
  ON "agent_todos"("agent_id", "template_id");
CREATE INDEX "agent_todos_created_by_user_id_idx" ON "agent_todos"("created_by_user_id");
CREATE INDEX "agent_todos_trigger_id_idx" ON "agent_todos"("trigger_id");
CREATE INDEX "agent_todos_thread_id_idx" ON "agent_todos"("thread_id");
CREATE INDEX "agent_todos_active_run_id_idx" ON "agent_todos"("active_run_id");

CREATE UNIQUE INDEX "agent_todo_steps_todo_id_sequence_key"
  ON "agent_todo_steps"("todo_id", "sequence");
CREATE UNIQUE INDEX "agent_todo_steps_todo_id_key_key"
  ON "agent_todo_steps"("todo_id", "key");
CREATE INDEX "agent_todo_steps_todo_id_idx" ON "agent_todo_steps"("todo_id");

ALTER TABLE "agent_todo_templates"
  ADD CONSTRAINT "agent_todo_templates_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_todo_templates_organization_id_agent_id_fkey"
  FOREIGN KEY ("organization_id", "agent_id") REFERENCES "agents"("organization_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_todo_templates_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_todo_templates_proposed_by_run_id_fkey"
  FOREIGN KEY ("proposed_by_run_id") REFERENCES "runs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agent_todos"
  ADD CONSTRAINT "agent_todos_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_todos_organization_id_agent_id_fkey"
  FOREIGN KEY ("organization_id", "agent_id") REFERENCES "agents"("organization_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_todos_agent_id_template_id_fkey"
  FOREIGN KEY ("agent_id", "template_id") REFERENCES "agent_todo_templates"("agent_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_todos_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_todos_trigger_id_fkey"
  FOREIGN KEY ("trigger_id") REFERENCES "agent_triggers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_todos_thread_id_fkey"
  FOREIGN KEY ("thread_id") REFERENCES "threads"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_todos_active_run_id_fkey"
  FOREIGN KEY ("active_run_id") REFERENCES "runs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agent_todo_steps"
  ADD CONSTRAINT "agent_todo_steps_todo_id_fkey"
  FOREIGN KEY ("todo_id") REFERENCES "agent_todos"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
