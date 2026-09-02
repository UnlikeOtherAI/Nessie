-- Calling the Personal Assistant with live voice.
--
-- Two tables. `voice_installations` is the server-minted device registry: the
-- identifier Ledger sees derives from `id`, because Ledger reserves daily
-- budget per device slot and a client-chosen identifier could multiply those
-- reservations without limit. `voice_sessions` is one call — call-scoped
-- across credential rotations, so the 30-minute Gemini credential can be
-- replaced in place while the usage stream and the single transcript slot
-- stay attached to the same row.
--
-- Spec: docs/plans/2026-09-02-gemini-voice-calling.md

-- CreateEnum
CREATE TYPE "VoiceInstallationPlatform" AS ENUM ('web', 'ios', 'android');

-- CreateEnum
CREATE TYPE "VoiceSessionStatus" AS ENUM ('active', 'ended', 'failed');

-- CreateTable
CREATE TABLE "voice_installations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "platform" "VoiceInstallationPlatform" NOT NULL,
    "label" TEXT,
    "revoked_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "uoa_subject" TEXT,
    "uoa_organization_id" TEXT,
    "uoa_team_id" TEXT,
    "uoa_token_version" INTEGER,
    "ledger_session_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "credential_expires_at" TIMESTAMP(3) NOT NULL,
    "rotation_count" INTEGER NOT NULL DEFAULT 0,
    "status" "VoiceSessionStatus" NOT NULL DEFAULT 'active',
    "max_duration_ms" INTEGER NOT NULL,
    "max_tool_calls" INTEGER NOT NULL,
    "tool_call_count" INTEGER NOT NULL DEFAULT 0,
    "last_usage_sequence" INTEGER NOT NULL DEFAULT 0,
    "usage_complete" BOOLEAN NOT NULL DEFAULT false,
    "transcript_message_id" UUID,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "voice_installations_organization_id_idx" ON "voice_installations"("organization_id");

-- CreateIndex
CREATE INDEX "voice_installations_user_id_revoked_at_idx" ON "voice_installations"("user_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "voice_sessions_transcript_message_id_key" ON "voice_sessions"("transcript_message_id");

-- CreateIndex
CREATE INDEX "voice_sessions_organization_id_status_idx" ON "voice_sessions"("organization_id", "status");

-- CreateIndex
CREATE INDEX "voice_sessions_user_id_started_at_idx" ON "voice_sessions"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "voice_sessions_installation_id_status_idx" ON "voice_sessions"("installation_id", "status");

-- AddForeignKey
ALTER TABLE "voice_installations" ADD CONSTRAINT "voice_installations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "voice_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
