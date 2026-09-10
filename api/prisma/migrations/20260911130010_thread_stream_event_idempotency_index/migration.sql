-- Standalone so Prisma deploys the write-hot stream index concurrently.
CREATE UNIQUE INDEX CONCURRENTLY "thread_stream_events_idempotency_key_key"
  ON "thread_stream_events"("idempotency_key");
