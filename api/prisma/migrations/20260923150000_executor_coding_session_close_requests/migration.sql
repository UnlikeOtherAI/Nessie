-- The control plane's instructions to close coding sessions on a machine
-- (docs/executor-protocol/host-coding-sessions.md). A lease that ends, access
-- withdrawn, a paused or revoked executor, and a person's Close each write one
-- in the transaction that causes it; the heartbeat carries every unresolved one
-- as `codingSessionClose` until a later local-MCP report shows it done, or for
-- 24 hours at most.

-- CreateTable
CREATE TABLE "executor_coding_session_close_requests" (
    "id" UUID NOT NULL,
    "executor_id" UUID NOT NULL,
    "owner_key" TEXT NOT NULL,
    "session_id" UUID,
    "reason" TEXT NOT NULL,
    "requested_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "executor_coding_session_close_requests_pkey" PRIMARY KEY ("id"),
    -- The key the daemon derives for `_meta['nessie/owner']`, and nothing else.
    CONSTRAINT "executor_coding_session_close_requests_owner_key_digest"
      CHECK ("owner_key" ~ '^sha256:[a-f0-9]{64}$'),
    -- EXECUTOR_CODING_SESSION_CLOSE_REASONS in @nessie/schemas.
    CONSTRAINT "executor_coding_session_close_requests_reason_known"
      CHECK ("reason" IN ('lease_ended', 'access_revoked', 'executor_paused', 'executor_revoked', 'person'))
);

-- One open owner-wide request per owner and one per named session, so the
-- several transitions a pause or a revocation runs through say it once. Prisma
-- cannot express a partial index, so they live here only.
CREATE UNIQUE INDEX "executor_coding_session_close_requests_one_open_owner"
  ON "executor_coding_session_close_requests"("executor_id", "owner_key")
  WHERE "session_id" IS NULL AND "resolved_at" IS NULL;

CREATE UNIQUE INDEX "executor_coding_session_close_requests_one_open_session"
  ON "executor_coding_session_close_requests"("executor_id", "owner_key", "session_id")
  WHERE "session_id" IS NOT NULL AND "resolved_at" IS NULL;

-- CreateIndex
CREATE INDEX "executor_coding_session_close_requests_executor_id_resolved_idx" ON "executor_coding_session_close_requests"("executor_id", "resolved_at", "created_at");

-- AddForeignKey
ALTER TABLE "executor_coding_session_close_requests" ADD CONSTRAINT "executor_coding_session_close_requests_executor_id_fkey" FOREIGN KEY ("executor_id") REFERENCES "executors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_coding_session_close_requests" ADD CONSTRAINT "executor_coding_session_close_requests_requested_by_user_i_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
