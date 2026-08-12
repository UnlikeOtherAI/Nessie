-- Push suppression is conversation-scoped. A foreground client on one thread
-- must not silence a message in another thread of the same channel.

ALTER TABLE "user_push_surface_presence"
  ADD COLUMN "thread_id" UUID;

ALTER TABLE "user_push_surface_presence"
  ADD CONSTRAINT "user_push_surface_presence_thread_id_fkey"
  FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "idx_push_presence_thread"
  ON "user_push_surface_presence"(
    "organization_id", "user_id", "surface_kind", "channel_id", "thread_id", "last_seen_at"
  );
