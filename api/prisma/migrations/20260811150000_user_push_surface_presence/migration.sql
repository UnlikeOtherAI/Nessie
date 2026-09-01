-- Per-session foreground destination for page-aware push suppression.
CREATE TYPE "PushSurfaceKind" AS ENUM ('channel', 'ops_usage');

CREATE TABLE "user_push_surface_presence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "surface_kind" "PushSurfaceKind",
  "channel_id" UUID,
  "heartbeat_sequence" BIGINT NOT NULL,
  "last_seen_at" TIMESTAMP(3) NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_push_surface_presence_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "user_push_surface_presence"
  ADD CONSTRAINT "user_push_surface_presence_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_push_surface_presence"
  ADD CONSTRAINT "user_push_surface_presence_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_push_surface_presence"
  ADD CONSTRAINT "user_push_surface_presence_channel_id_fkey"
  FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "user_push_surface_presence_user_id_client_id_key"
  ON "user_push_surface_presence"("user_id", "client_id");
CREATE INDEX "user_push_surface_presence_organization_id_user_id_surface_kind_channel_id_last_seen_at_idx"
  ON "user_push_surface_presence"("organization_id", "user_id", "surface_kind", "channel_id", "last_seen_at");
CREATE INDEX "user_push_surface_presence_user_id_last_seen_at_idx"
  ON "user_push_surface_presence"("user_id", "last_seen_at");
