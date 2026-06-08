-- Bounded replay log for user-scoped realtime streams.
--
-- Each row is a single channel-scoped event with a monotonic SSE id. Clients
-- reconnect with Last-Event-ID and replay rows from their current channel
-- membership set.

CREATE TABLE "realtime_events" (
    "id" BIGSERIAL NOT NULL,
    "organization_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "realtime_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_realtime_events_replay"
    ON "realtime_events"("channel_id", "id");

CREATE INDEX "realtime_events_organization_id_created_at_idx"
    ON "realtime_events"("organization_id", "created_at");
