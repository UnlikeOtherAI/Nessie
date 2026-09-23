-- Ticket-driven agents, contracts only (docs/plans/2026-09-23-ticket-driven-agents,
-- T0). Two trigger types, the trigger scope columns, and the tables that later
-- PRs write: one ticket's work, standing machine access and its pool, and
-- agent reminders. Nothing here is read or written yet, and every create
-- surface refuses the two new trigger types until their dispatch ships.
--
-- Every closed vocabulary below is also a Zod enum in
-- packages/schemas/src/ticket-work.ts, and
-- api/test/ticket-work-contracts-migration.test.ts fails when the two lists
-- disagree. Each vocabulary CHECK is written with an explicit IS NOT NULL
-- where the column must be set: a NULL makes an IN test NULL, and a CHECK that
-- evaluates to NULL passes.
--
-- Additive only: no existing column is dropped or tightened.

-- AlterEnum
-- Not used by anything in this migration, so adding it inside the same
-- transaction is safe (the value is only unusable until the transaction ends).
ALTER TYPE "AgentTriggerType" ADD VALUE IF NOT EXISTS 'ticket_changed';
ALTER TYPE "AgentTriggerType" ADD VALUE IF NOT EXISTS 'document_changed';

-- AlterTable
ALTER TABLE "agent_triggers" ADD COLUMN     "scope_board_id" UUID,
ADD COLUMN     "scope_project_id" UUID;

-- CreateTable
CREATE TABLE "agent_ticket_work" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "trigger_id" UUID,
    "agent_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "state_reason" TEXT,
    "policy_id" UUID,
    "executor_id" UUID,
    "started_by_user_id" UUID,
    "started_by_event_id" UUID,
    "queue_position" INTEGER,
    "enqueued_at" TIMESTAMP(3),
    "session_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_observed_turn" JSONB NOT NULL DEFAULT '{}',
    "pull_request_url" TEXT,
    "last_pr_state" TEXT,
    "last_checks" JSONB,
    "pr_seen_at" TIMESTAMP(3),
    "wake_count" INTEGER NOT NULL DEFAULT 0,
    "active_ms" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "last_wake_at" TIMESTAMP(3),
    "last_wake_reason" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "ended_reason" TEXT,
    "ended_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_ticket_work_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_ticket_work_status_known"
      CHECK (
        "status" IN (
          'queued', 'active', 'parked', 'waiting_machine',
          'done', 'cancelled', 'failed'
        )
      ),
    CONSTRAINT "agent_ticket_work_state_reason_known"
      CHECK (
        "state_reason" IS NULL
        OR "state_reason" IN (
          'queued_no_free_machine', 'queued_machines_offline',
          'machine_access_not_set_up', 'machine_access_suspended',
          'machine_access_ended', 'machine_offline',
          'limit_wakes', 'limit_hours', 'limit_cost', 'limit_daily',
          'left_flow', 'merged', 'mover_lost_access', 'trigger_disabled'
        )
      ),
    -- A live record has not ended; a terminal one has, with a reason from the
    -- state-reason vocabulary (the reason it ended is the reason it is final).
    CONSTRAINT "agent_ticket_work_ended_known"
      CHECK (
        (
          "status" IN ('queued', 'active', 'parked', 'waiting_machine')
          AND "ended_at" IS NULL
          AND "ended_reason" IS NULL
        )
        OR (
          "status" IN ('done', 'cancelled', 'failed')
          AND "ended_at" IS NOT NULL
          AND "ended_reason" IS NOT NULL
          AND "ended_reason" IN (
            'queued_no_free_machine', 'queued_machines_offline',
            'machine_access_not_set_up', 'machine_access_suspended',
            'machine_access_ended', 'machine_offline',
            'limit_wakes', 'limit_hours', 'limit_cost', 'limit_daily',
            'left_flow', 'merged', 'mover_lost_access', 'trigger_disabled'
          )
        )
      ),
    CONSTRAINT "agent_ticket_work_last_wake_reason_known"
      CHECK (
        "last_wake_reason" IS NULL
        OR "last_wake_reason" IN (
          'pickup', 'dequeued', 'queued',
          'ticket_commented', 'ticket_description_changed',
          'ticket_priority_changed', 'ticket_moved',
          'thread_message', 'document_changed',
          'session_turn_ended', 'session_interrupted', 'session_failed',
          'session_closed', 'reminder', 'quiet', 'machine_back_online'
        )
      ),
    -- Prisma declares a scalar list column nullable; an absent session list
    -- is an empty one, never NULL.
    CONSTRAINT "agent_ticket_work_counters_valid"
      CHECK (
        "session_ids" IS NOT NULL
        AND "wake_count" >= 0
        AND "active_ms" >= 0
        AND "cost_usd" >= 0
        AND ("queue_position" IS NULL OR "queue_position" >= 1)
      )
);

-- CreateTable
CREATE TABLE "agent_reminders" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "work_id" UUID,
    "due_at" TIMESTAMP(3) NOT NULL,
    "note" TEXT NOT NULL,
    "created_by_run_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fired_at" TIMESTAMP(3),
    "cancelled_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_reminders_pkey" PRIMARY KEY ("id"),
    -- The status names the lifecycle, and each terminal status carries its
    -- own field: `fired_at` exactly when fired, a known `cancelled_reason`
    -- exactly when cancelled.
    CONSTRAINT "agent_reminders_status_known"
      CHECK (
        (
          "status" = 'pending'
          AND "fired_at" IS NULL
          AND "cancelled_reason" IS NULL
        )
        OR (
          "status" = 'fired'
          AND "fired_at" IS NOT NULL
          AND "cancelled_reason" IS NULL
        )
        OR (
          "status" = 'cancelled'
          AND "fired_at" IS NULL
          AND "cancelled_reason" IS NOT NULL
          AND "cancelled_reason" IN ('replaced', 'work_ended', 'person')
        )
      )
);

-- CreateTable
CREATE TABLE "executor_standing_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "trigger_id" UUID,
    "agent_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preparing',
    "suspended_reason" TEXT,
    "ended_reason" TEXT,
    "host_profile" JSONB NOT NULL,
    "trigger_digest" TEXT NOT NULL,
    "author_origin" JSONB,
    "confirmed_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "ended_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "executor_standing_policies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "executor_standing_policies_status_known"
      CHECK ("status" IN ('preparing', 'live', 'suspended', 'ended')),
    -- Set exactly while suspended.
    CONSTRAINT "executor_standing_policies_suspended_reason_known"
      CHECK (
        ("status" <> 'suspended' AND "suspended_reason" IS NULL)
        OR (
          "status" = 'suspended'
          AND "suspended_reason" IS NOT NULL
          AND "suspended_reason" IN ('trigger_changed', 'descriptor_changed')
        )
      ),
    -- Set exactly when ended.
    CONSTRAINT "executor_standing_policies_ended_reason_known"
      CHECK (
        ("status" <> 'ended' AND "ended_at" IS NULL AND "ended_reason" IS NULL)
        OR (
          "status" = 'ended'
          AND "ended_at" IS NOT NULL
          AND "ended_reason" IS NOT NULL
          AND "ended_reason" IN (
            'person', 'access_revoked', 'executor_paused', 'executor_drained',
            'executor_revoked', 'descriptor_narrowed',
            'author_lost_access', 'author_deactivated', 'author_left_organization',
            'agent_unbound', 'scope_archived', 'trigger_deleted',
            'expired', 'replaced'
          )
        )
      ),
    -- A policy that can bind has been confirmed, with the author's origin
    -- captured at that moment; one still preparing has not.
    CONSTRAINT "executor_standing_policies_confirmed_known"
      CHECK (
        ("status" <> 'preparing' OR "confirmed_at" IS NULL)
        AND (
          "status" NOT IN ('live', 'suspended')
          OR ("confirmed_at" IS NOT NULL AND "author_origin" IS NOT NULL)
        )
      )
);

-- CreateTable
CREATE TABLE "executor_standing_policy_executors" (
    "policy_id" UUID NOT NULL,
    "executor_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "descriptor_config_digest" TEXT NOT NULL,
    "local_policy_digest" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "executor_standing_policy_executors_pkey" PRIMARY KEY ("policy_id","executor_id"),
    -- A pool is one or two machines.
    CONSTRAINT "executor_standing_policy_executors_position_known"
      CHECK ("position" IN (0, 1))
);

-- One live work record per (trigger, ticket): a re-entry is a follow on the
-- same record, never a second pickup. Prisma cannot express a partial index,
-- so this and the two below live here only.
CREATE UNIQUE INDEX "agent_ticket_work_one_live"
  ON "agent_ticket_work"("trigger_id", "task_id")
  WHERE "status" IN ('queued', 'active', 'parked', 'waiting_machine');

-- One ticket per machine: the pool dispatcher's assignment holds even when
-- two pickups race for the same free executor.
CREATE UNIQUE INDEX "agent_ticket_work_one_active_per_executor"
  ON "agent_ticket_work"("executor_id")
  WHERE "status" = 'active' AND "executor_id" IS NOT NULL;

-- One pending reminder per work record: a new one replaces it.
CREATE UNIQUE INDEX "agent_reminders_one_pending_per_work"
  ON "agent_reminders"("work_id")
  WHERE "status" = 'pending' AND "work_id" IS NOT NULL;

-- CreateIndex
CREATE INDEX "agent_ticket_work_trigger_id_task_id_idx" ON "agent_ticket_work"("trigger_id", "task_id");

-- CreateIndex
CREATE INDEX "agent_ticket_work_task_id_status_idx" ON "agent_ticket_work"("task_id", "status");

-- CreateIndex
CREATE INDEX "agent_ticket_work_agent_id_status_idx" ON "agent_ticket_work"("agent_id", "status");

-- CreateIndex
CREATE INDEX "agent_ticket_work_thread_id_idx" ON "agent_ticket_work"("thread_id");

-- CreateIndex
CREATE INDEX "agent_ticket_work_policy_id_status_idx" ON "agent_ticket_work"("policy_id", "status");

-- CreateIndex
CREATE INDEX "agent_ticket_work_executor_id_status_idx" ON "agent_ticket_work"("executor_id", "status");

-- CreateIndex
CREATE INDEX "agent_ticket_work_status_enqueued_at_idx" ON "agent_ticket_work"("status", "enqueued_at");

-- CreateIndex
CREATE INDEX "agent_ticket_work_started_by_user_id_idx" ON "agent_ticket_work"("started_by_user_id");

-- CreateIndex
CREATE INDEX "agent_ticket_work_started_by_event_id_idx" ON "agent_ticket_work"("started_by_event_id");

-- CreateIndex
CREATE INDEX "agent_reminders_status_due_at_idx" ON "agent_reminders"("status", "due_at");

-- CreateIndex
CREATE INDEX "agent_reminders_thread_id_status_idx" ON "agent_reminders"("thread_id", "status");

-- CreateIndex
CREATE INDEX "agent_reminders_agent_id_created_at_idx" ON "agent_reminders"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_reminders_work_id_idx" ON "agent_reminders"("work_id");

-- CreateIndex
CREATE INDEX "agent_reminders_created_by_run_id_idx" ON "agent_reminders"("created_by_run_id");

-- CreateIndex
CREATE INDEX "executor_standing_policies_trigger_id_status_idx" ON "executor_standing_policies"("trigger_id", "status");

-- CreateIndex
CREATE INDEX "executor_standing_policies_author_user_id_status_idx" ON "executor_standing_policies"("author_user_id", "status");

-- CreateIndex
CREATE INDEX "executor_standing_policies_agent_id_status_idx" ON "executor_standing_policies"("agent_id", "status");

-- CreateIndex
CREATE INDEX "executor_standing_policy_executors_executor_id_idx" ON "executor_standing_policy_executors"("executor_id");

-- CreateIndex
CREATE UNIQUE INDEX "executor_standing_policy_executors_policy_id_position_key" ON "executor_standing_policy_executors"("policy_id", "position");

-- CreateIndex
CREATE INDEX "agent_triggers_scope_board_id_idx" ON "agent_triggers"("scope_board_id");

-- CreateIndex
CREATE INDEX "agent_triggers_scope_project_id_idx" ON "agent_triggers"("scope_project_id");

-- AddForeignKey
ALTER TABLE "agent_triggers" ADD CONSTRAINT "agent_triggers_scope_project_id_fkey" FOREIGN KEY ("scope_project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_triggers" ADD CONSTRAINT "agent_triggers_scope_board_id_fkey" FOREIGN KEY ("scope_board_id") REFERENCES "boards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_ticket_work" ADD CONSTRAINT "agent_ticket_work_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_ticket_work" ADD CONSTRAINT "agent_ticket_work_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "agent_triggers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_ticket_work" ADD CONSTRAINT "agent_ticket_work_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_ticket_work" ADD CONSTRAINT "agent_ticket_work_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_ticket_work" ADD CONSTRAINT "agent_ticket_work_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_ticket_work" ADD CONSTRAINT "agent_ticket_work_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_ticket_work" ADD CONSTRAINT "agent_ticket_work_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "executor_standing_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_ticket_work" ADD CONSTRAINT "agent_ticket_work_executor_id_fkey" FOREIGN KEY ("executor_id") REFERENCES "executors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_ticket_work" ADD CONSTRAINT "agent_ticket_work_started_by_user_id_fkey" FOREIGN KEY ("started_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_ticket_work" ADD CONSTRAINT "agent_ticket_work_started_by_event_id_fkey" FOREIGN KEY ("started_by_event_id") REFERENCES "task_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_reminders" ADD CONSTRAINT "agent_reminders_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_reminders" ADD CONSTRAINT "agent_reminders_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_reminders" ADD CONSTRAINT "agent_reminders_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "agent_ticket_work"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_reminders" ADD CONSTRAINT "agent_reminders_created_by_run_id_fkey" FOREIGN KEY ("created_by_run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_standing_policies" ADD CONSTRAINT "executor_standing_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_standing_policies" ADD CONSTRAINT "executor_standing_policies_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_standing_policies" ADD CONSTRAINT "executor_standing_policies_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "agent_triggers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_standing_policies" ADD CONSTRAINT "executor_standing_policies_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_standing_policies" ADD CONSTRAINT "executor_standing_policies_ended_by_user_id_fkey" FOREIGN KEY ("ended_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_standing_policy_executors" ADD CONSTRAINT "executor_standing_policy_executors_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "executor_standing_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_standing_policy_executors" ADD CONSTRAINT "executor_standing_policy_executors_executor_id_fkey" FOREIGN KEY ("executor_id") REFERENCES "executors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
