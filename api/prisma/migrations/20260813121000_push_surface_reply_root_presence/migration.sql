ALTER TABLE "user_push_surface_presence"
  ADD COLUMN "root_message_id" UUID;

ALTER TABLE "user_push_surface_presence"
  ADD CONSTRAINT "user_push_surface_presence_root_message_id_fkey"
  FOREIGN KEY ("root_message_id") REFERENCES "messages"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "idx_push_presence_reply_root"
  ON "user_push_surface_presence"(
    "organization_id",
    "user_id",
    "surface_kind",
    "channel_id",
    "thread_id",
    "root_message_id",
    "last_seen_at"
  );
