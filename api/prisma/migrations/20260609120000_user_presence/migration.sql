-- User presence registry for foreground realtime streams.
--
-- One row per user tracks how many user-scoped SSE streams are currently open
-- and when that user was last observed. The worker will later read this table
-- before deciding whether a push notification should be routed.

CREATE TABLE "user_presence" (
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connections" INTEGER NOT NULL DEFAULT 0,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_presence_pkey" PRIMARY KEY ("user_id")
);

CREATE INDEX "user_presence_last_seen_at_idx" ON "user_presence"("last_seen_at");
