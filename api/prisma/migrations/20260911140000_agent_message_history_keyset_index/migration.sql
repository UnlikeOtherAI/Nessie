-- The history reader follows this complete stable keyset. This is intentionally
-- a standalone migration: PostgreSQL cannot create an index concurrently inside
-- Prisma's migration transaction when other statements share the migration.
CREATE INDEX CONCURRENTLY "messages_agent_id_created_at_id_keyset_idx"
  ON "messages" ("agent_id", "created_at" DESC, "id" DESC);
