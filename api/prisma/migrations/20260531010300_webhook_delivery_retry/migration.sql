-- Inbound webhook hardening (sp-webhook).
-- 1. Optional HMAC signing secret per webhook trigger. When set, the intake
--    endpoint requires a valid X-Nessie-Signature instead of a bearer key.
-- 2. Delivery retry/backoff bookkeeping: a `failed` delivery with
--    retry_count < max and next_retry_at <= now is retryable by the worker poller.

ALTER TABLE "agent_triggers" ADD COLUMN "signing_secret" TEXT;

ALTER TABLE "agent_trigger_deliveries" ADD COLUMN "retry_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "agent_trigger_deliveries" ADD COLUMN "next_retry_at" TIMESTAMP(3);

-- Retry poller scan: find failed deliveries due for re-attempt.
CREATE INDEX "agent_trigger_deliveries_status_next_retry_at_idx"
  ON "agent_trigger_deliveries" ("status", "next_retry_at");
