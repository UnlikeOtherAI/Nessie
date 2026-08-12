-- Availability returns opaque, short-lived, one-use choices rather than a
-- caller-selectable executor id. Only the SHA-256 handle digest is durable.
CREATE TABLE "executor_availability_candidates" (
    "id" UUID NOT NULL,
    "executor_id" UUID NOT NULL,
    "capability_revision_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "run_id" UUID,
    "project_id" UUID,
    "operation_keys" TEXT[] NOT NULL,
    "authorization_revision" INTEGER NOT NULL,
    "handle_digest" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "executor_availability_candidates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "executor_availability_candidates_operation_keys_not_empty"
      CHECK (cardinality("operation_keys") > 0),
    CONSTRAINT "executor_availability_candidates_operation_keys_known"
      CHECK ("operation_keys" <@ ARRAY[
        'file.list', 'file.read', 'file.write', 'command.run',
        'browser.open', 'browser.observe', 'browser.act',
        'workspace.promote', 'sandbox.stop', 'coding.launch', 'coding.attach',
        'coding.observe', 'coding.prompt', 'coding.interrupt', 'coding.close'
      ]::TEXT[])
);

CREATE UNIQUE INDEX "executor_availability_candidates_handle_digest_key"
  ON "executor_availability_candidates"("handle_digest");
CREATE INDEX "executor_availability_candidates_actor_user_id_agent_id_expires_at_idx"
  ON "executor_availability_candidates"("actor_user_id", "agent_id", "expires_at");
CREATE INDEX "executor_availability_candidates_executor_id_expires_at_idx"
  ON "executor_availability_candidates"("executor_id", "expires_at");
CREATE INDEX "executor_availability_candidates_run_id_idx"
  ON "executor_availability_candidates"("run_id");

ALTER TABLE "executor_availability_candidates"
  ADD CONSTRAINT "executor_availability_candidates_executor_id_fkey"
  FOREIGN KEY ("executor_id") REFERENCES "executors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "executor_availability_candidates"
  ADD CONSTRAINT "executor_availability_candidates_capability_revision_id_fkey"
  FOREIGN KEY ("capability_revision_id") REFERENCES "executor_capability_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "executor_availability_candidates"
  ADD CONSTRAINT "executor_availability_candidates_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "executor_availability_candidates"
  ADD CONSTRAINT "executor_availability_candidates_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "executor_availability_candidates"
  ADD CONSTRAINT "executor_availability_candidates_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
