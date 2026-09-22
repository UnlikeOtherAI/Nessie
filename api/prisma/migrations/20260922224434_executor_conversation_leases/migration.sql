-- A person's own follow-ups in the conversation they launched local apps in
-- keep the executor's local-apps pair. The lease is not a binding: each carried
-- run is bound afresh against a newly resolved candidate, and the lease only
-- names which later runs may be. Every binding made under it points back, so
-- dispatch can fence a binding whose lease has ended or expired.

-- CreateTable
CREATE TABLE "executor_conversation_leases" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "executor_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "root_message_id" UUID NOT NULL,
    "launch_run_id" UUID NOT NULL,
    "operation_keys" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL,
    "idle_expires_at" TIMESTAMP(3) NOT NULL,
    "absolute_expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "ended_reason" TEXT,
    "ended_by_user_id" UUID,

    CONSTRAINT "executor_conversation_leases_pkey" PRIMARY KEY ("id"),
    -- Only the local-apps pair ever carries across runs. Browser, coding and
    -- command bundles never do (full-actuation §7), so the set is pinned to
    -- exactly those two keys rather than to a subset of the implemented list
    -- (the pattern of 20260922190000_executor_availability_known_operation_keys).
    CONSTRAINT "executor_conversation_leases_operation_keys_local_apps"
      CHECK (
        "operation_keys" @> ARRAY['mcp.tools', 'mcp.call']::TEXT[]
        AND "operation_keys" <@ ARRAY['mcp.tools', 'mcp.call']::TEXT[]
        AND cardinality("operation_keys") = 2
      ),
    -- A closed vocabulary, set exactly when the lease has ended. The explicit
    -- IS NOT NULL matters: a NULL reason would make the IN test NULL, and a
    -- CHECK that evaluates to NULL passes.
    CONSTRAINT "executor_conversation_leases_ended_reason_known"
      CHECK (
        ("ended_at" IS NULL AND "ended_reason" IS NULL)
        OR (
          "ended_at" IS NOT NULL
          AND "ended_reason" IS NOT NULL
          AND "ended_reason" IN (
            'person', 'access_revoked', 'executor_paused', 'executor_revoked',
            'descriptor_narrowed', 'expired', 'replaced'
          )
        )
      )
);

-- One live lease per (thread, root message, agent, person). Prisma cannot
-- express a partial index, so it lives here only.
CREATE UNIQUE INDEX "executor_conversation_leases_one_live"
  ON "executor_conversation_leases"("thread_id", "root_message_id", "agent_id", "actor_user_id")
  WHERE "ended_at" IS NULL;

-- CreateIndex
CREATE INDEX "executor_conversation_leases_thread_id_agent_id_actor_user__idx" ON "executor_conversation_leases"("thread_id", "agent_id", "actor_user_id");

-- CreateIndex
CREATE INDEX "executor_conversation_leases_executor_id_ended_at_idx" ON "executor_conversation_leases"("executor_id", "ended_at");

-- CreateIndex
CREATE INDEX "executor_conversation_leases_actor_user_id_ended_at_idx" ON "executor_conversation_leases"("actor_user_id", "ended_at");

-- AddForeignKey
ALTER TABLE "executor_conversation_leases" ADD CONSTRAINT "executor_conversation_leases_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_conversation_leases" ADD CONSTRAINT "executor_conversation_leases_executor_id_fkey" FOREIGN KEY ("executor_id") REFERENCES "executors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_conversation_leases" ADD CONSTRAINT "executor_conversation_leases_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_conversation_leases" ADD CONSTRAINT "executor_conversation_leases_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_conversation_leases" ADD CONSTRAINT "executor_conversation_leases_ended_by_user_id_fkey" FOREIGN KEY ("ended_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_conversation_leases" ADD CONSTRAINT "executor_conversation_leases_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_conversation_leases" ADD CONSTRAINT "executor_conversation_leases_root_message_id_fkey" FOREIGN KEY ("root_message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_conversation_leases" ADD CONSTRAINT "executor_conversation_leases_launch_run_id_fkey" FOREIGN KEY ("launch_run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "executor_bindings" ADD COLUMN "lease_id" UUID;

-- CreateIndex
CREATE INDEX "executor_bindings_lease_id_idx" ON "executor_bindings"("lease_id");

-- AddForeignKey
ALTER TABLE "executor_bindings" ADD CONSTRAINT "executor_bindings_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "executor_conversation_leases"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
