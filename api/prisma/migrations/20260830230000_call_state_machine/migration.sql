ALTER TABLE "calls"
  ALTER COLUMN "room_id" DROP NOT NULL,
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'jitsi_embedded',
  ADD COLUMN "meeting_uri" TEXT,
  ADD COLUMN "ring_expires_at" TIMESTAMP(3),
  ADD COLUMN "created_via_agent_id" UUID,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

UPDATE "calls"
SET "provider" = 'jitsi_embedded',
    "status" = CASE WHEN "status" = 'active' THEN 'ended' ELSE "status" END,
    "ended_at" = CASE WHEN "status" = 'active' THEN COALESCE("ended_at", CURRENT_TIMESTAMP) ELSE "ended_at" END;

CREATE TABLE "call_invites" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "call_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'ringing',
  "responded_at" TIMESTAMP(3),

  CONSTRAINT "call_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "call_invites_call_id_user_id_key" ON "call_invites"("call_id", "user_id");
CREATE INDEX "call_invites_user_id_state_idx" ON "call_invites"("user_id", "state");
CREATE UNIQUE INDEX "calls_one_live_call_per_channel" ON "calls"("channel_id")
  WHERE "status" IN ('ringing', 'active');

ALTER TABLE "calls"
  ADD CONSTRAINT "calls_created_via_agent_id_fkey"
  FOREIGN KEY ("created_via_agent_id") REFERENCES "agents"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "call_invites"
  ADD CONSTRAINT "call_invites_call_id_fkey"
  FOREIGN KEY ("call_id") REFERENCES "calls"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "call_invites_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
