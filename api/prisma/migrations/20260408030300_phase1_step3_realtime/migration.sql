CREATE TABLE "thread_stream_events" (
  "id" BIGSERIAL PRIMARY KEY,
  "thread_id" UUID NOT NULL,
  "event_name" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "idx_thread_stream_events_replay"
  ON "thread_stream_events" ("thread_id", "id");
