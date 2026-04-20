CREATE TABLE "calls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "channel_id" UUID NOT NULL,
    "room_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "started_by_id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "call_participants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "call_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),

    CONSTRAINT "call_participants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "calls_room_id_key" ON "calls"("room_id");
CREATE INDEX "calls_channel_id_idx" ON "calls"("channel_id");
CREATE INDEX "calls_status_idx" ON "calls"("status");
CREATE UNIQUE INDEX "call_participants_call_id_user_id_key" ON "call_participants"("call_id", "user_id");

ALTER TABLE "calls"
  ADD CONSTRAINT "calls_channel_id_fkey"
  FOREIGN KEY ("channel_id")
  REFERENCES "channels"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "calls"
  ADD CONSTRAINT "calls_started_by_id_fkey"
  FOREIGN KEY ("started_by_id")
  REFERENCES "users"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "call_participants"
  ADD CONSTRAINT "call_participants_call_id_fkey"
  FOREIGN KEY ("call_id")
  REFERENCES "calls"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "call_participants"
  ADD CONSTRAINT "call_participants_user_id_fkey"
  FOREIGN KEY ("user_id")
  REFERENCES "users"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
