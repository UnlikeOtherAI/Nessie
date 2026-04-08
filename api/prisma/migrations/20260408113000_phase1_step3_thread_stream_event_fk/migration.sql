DELETE FROM "thread_stream_events" AS "events"
WHERE NOT EXISTS (
  SELECT 1
  FROM "threads" AS "thread"
  WHERE "thread"."id" = "events"."thread_id"
);

ALTER TABLE "thread_stream_events"
ADD CONSTRAINT "thread_stream_events_thread_id_fkey"
FOREIGN KEY ("thread_id") REFERENCES "threads"("id")
ON DELETE CASCADE;
