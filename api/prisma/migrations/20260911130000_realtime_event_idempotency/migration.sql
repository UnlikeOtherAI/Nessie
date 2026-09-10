-- Completion follow-ups are queue-redelivered independently of the run that
-- committed the answer. Stable keys return the existing event without
-- appending or announcing it a second time.
--
-- The unique indexes follow in standalone migrations so Prisma can run each
-- CREATE INDEX CONCURRENTLY outside a multi-statement migration transaction.
ALTER TABLE "thread_stream_events" ADD COLUMN "idempotency_key" TEXT;
ALTER TABLE "realtime_events" ADD COLUMN "idempotency_key" TEXT;
