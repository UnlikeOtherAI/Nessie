CREATE TABLE "executor_host_sessions" (
    "executor_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "owner_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "root" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reported_at" TIMESTAMP(3) NOT NULL,
    "requested_until" TIMESTAMP(3) NOT NULL,
    "captured_at" TIMESTAMP(3),
    "screen_ciphertext" TEXT,
    CONSTRAINT "executor_host_sessions_pkey" PRIMARY KEY ("executor_id", "session_id"),
    CONSTRAINT "executor_host_sessions_executor_id_fkey" FOREIGN KEY ("executor_id")
      REFERENCES "executors"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "executor_host_sessions_requested_until_idx" ON "executor_host_sessions"("requested_until");
CREATE TABLE "executor_host_session_shares" (
    "executor_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "executor_host_session_shares_pkey" PRIMARY KEY ("executor_id", "session_id", "user_id"),
    CONSTRAINT "executor_host_session_shares_session_fkey" FOREIGN KEY ("executor_id", "session_id")
      REFERENCES "executor_host_sessions"("executor_id", "session_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "executor_host_session_shares_user_id_fkey" FOREIGN KEY ("user_id")
      REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "executor_host_session_shares_user_id_idx" ON "executor_host_session_shares"("user_id");
