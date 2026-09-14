-- Run-derived history reads keyset by the conversation thread. Kept separate
-- so PostgreSQL can build this large-table index without a migration lock.
CREATE INDEX CONCURRENTLY "messages_thread_id_created_at_id_keyset_idx"
  ON "messages" ("thread_id", "created_at" DESC, "id" DESC);
