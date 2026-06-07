-- Device-token registry for native push targeting.
--
-- One row per (user, native APNs/FCM device token). Mobile apps register the
-- native token on every launch so the push pipeline can fan a notification out
-- to a user's devices. `organization_id`-scoped like every other child table;
-- the unique (user_id, token) keeps re-registration idempotent.

CREATE TYPE "DevicePlatform" AS ENUM ('ios', 'android');

CREATE TABLE "device_tokens" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "token" TEXT NOT NULL,
    "app_version" TEXT,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "device_tokens_user_id_token_key" ON "device_tokens"("user_id", "token");

CREATE INDEX "device_tokens_organization_id_idx" ON "device_tokens"("organization_id");

CREATE INDEX "device_tokens_user_id_idx" ON "device_tokens"("user_id");
