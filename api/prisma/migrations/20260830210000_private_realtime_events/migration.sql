-- Durable, recipient-private events use the same bounded replay log as
-- channel events. A user id is intentionally not inferred from payload data:
-- it is an access boundary used by both live delivery and replay.
ALTER TABLE "realtime_events"
  ALTER COLUMN "channel_id" DROP NOT NULL,
  ADD COLUMN "recipient_user_id" UUID;

CREATE INDEX "idx_realtime_events_user_replay"
  ON "realtime_events" ("organization_id", "recipient_user_id", "id");
