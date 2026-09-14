-- Standalone so Prisma deploys the write-hot realtime index concurrently.
CREATE UNIQUE INDEX CONCURRENTLY "realtime_events_idempotency_key_key"
  ON "realtime_events"("idempotency_key");
