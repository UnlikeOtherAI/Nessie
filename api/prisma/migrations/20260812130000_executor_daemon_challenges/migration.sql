-- A daemon challenge is single-use. The raw challenge is never persisted:
-- claim only receives its hash after the daemon has proved possession with its
-- already-paired Ed25519 key.
CREATE TABLE "executor_daemon_challenges" (
    "id" UUID NOT NULL,
    "executor_id" UUID NOT NULL,
    "challenge_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "executor_daemon_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "executor_daemon_challenges_challenge_hash_key" ON "executor_daemon_challenges"("challenge_hash");
CREATE INDEX "executor_daemon_challenges_executor_id_expires_at_idx" ON "executor_daemon_challenges"("executor_id", "expires_at");
CREATE INDEX "executor_daemon_challenges_expires_at_idx" ON "executor_daemon_challenges"("expires_at");

ALTER TABLE "executor_daemon_challenges" ADD CONSTRAINT "executor_daemon_challenges_executor_id_fkey" FOREIGN KEY ("executor_id") REFERENCES "executors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
