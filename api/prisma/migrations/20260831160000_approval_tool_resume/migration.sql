-- True approval suspend/resume for policy-gated tool calls. These fields are
-- additive and server-only; the partial index makes a redelivered tool call
-- idempotent without constraining the existing deferred-effect approvals.
ALTER TABLE "approval_requests"
  ADD COLUMN "tool_call_id" TEXT,
  ADD COLUMN "tool_name" TEXT,
  ADD COLUMN "args_hash" TEXT,
  ADD COLUMN "resume_state" JSONB,
  ADD COLUMN "proof_consumed_at" TIMESTAMPTZ;

CREATE UNIQUE INDEX "approval_requests_run_id_tool_call_id_key"
  ON "approval_requests"("run_id", "tool_call_id")
  WHERE "tool_call_id" IS NOT NULL;
