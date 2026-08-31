-- Opt-in, structural-only demonstration capture. Tool arguments are redacted
-- before insertion by the worker; tool outputs are never retained here.

CREATE TYPE "DemonstrationStatus" AS ENUM ('recording', 'captured', 'generalized', 'discarded');

CREATE TABLE "demonstrations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "started_by_user_id" UUID NOT NULL,
    "status" "DemonstrationStatus" NOT NULL DEFAULT 'recording',
    "step_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "captured_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demonstrations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "demonstration_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "demonstration_id" UUID NOT NULL,
    "run_id" UUID,
    "agent_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "tool_name" TEXT NOT NULL,
    "arguments_json" JSONB NOT NULL,
    "success" BOOLEAN NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL,
    "duration_ms" INTEGER NOT NULL,

    CONSTRAINT "demonstration_steps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "demonstrations_organization_id_started_by_user_id_started_at_idx"
  ON "demonstrations"("organization_id", "started_by_user_id", "started_at" DESC);
CREATE INDEX "demonstrations_agent_id_thread_id_status_idx"
  ON "demonstrations"("agent_id", "thread_id", "status");
CREATE INDEX "demonstrations_channel_id_idx" ON "demonstrations"("channel_id");
CREATE UNIQUE INDEX "demonstrations_recording_agent_thread_key"
  ON "demonstrations"("agent_id", "thread_id")
  WHERE "status" = 'recording';
CREATE UNIQUE INDEX "demonstration_steps_demonstration_id_sequence_key"
  ON "demonstration_steps"("demonstration_id", "sequence");
CREATE INDEX "demonstration_steps_run_id_idx" ON "demonstration_steps"("run_id");
CREATE INDEX "demonstration_steps_agent_id_idx" ON "demonstration_steps"("agent_id");

ALTER TABLE "demonstrations"
  ADD CONSTRAINT "demonstrations_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "demonstrations_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "demonstrations_channel_id_fkey"
    FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "demonstrations_thread_id_fkey"
    FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "demonstrations_started_by_user_id_fkey"
    FOREIGN KEY ("started_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "demonstration_steps"
  ADD CONSTRAINT "demonstration_steps_demonstration_id_fkey"
    FOREIGN KEY ("demonstration_id") REFERENCES "demonstrations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "demonstration_steps_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "demonstration_steps_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
