-- Crash checkpoints (horizontal scaling, phase 3.1).
--
-- A run whose worker dies is re-claimed and, until now, re-executed from the
-- prompt: every tool that already ran ran again and every inference was billed
-- twice. These three columns carry the agentic loop's own working state on the
-- run's existing checkpoint row — one row per run, `run_id` is already unique —
-- so the re-claiming executor resumes the same run in place.
--
-- `crash_executor_token` is the `runs.executor_token` of the executor that
-- wrote the state. Every write is conditional on the run still carrying it, so
-- a fenced-out executor cannot clobber the live one's checkpoint.
ALTER TABLE "run_checkpoints"
  ADD COLUMN "crash_state" JSONB,
  ADD COLUMN "crash_executor_token" UUID,
  ADD COLUMN "crash_updated_at" TIMESTAMP(3);
