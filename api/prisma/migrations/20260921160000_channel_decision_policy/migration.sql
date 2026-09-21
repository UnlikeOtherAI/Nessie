ALTER TABLE "channels" ADD COLUMN "decision_policy" JSONB;

ALTER TABLE "run_thread_pending_messages" ADD COLUMN "prompt_override" TEXT;

ALTER TABLE "runs" ADD COLUMN "prompt_override" TEXT;

ALTER TABLE "messages" ADD COLUMN "channel_decision" JSONB;
