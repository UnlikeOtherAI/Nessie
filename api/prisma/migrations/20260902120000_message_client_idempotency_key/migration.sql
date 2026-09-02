-- Client idempotency key for message creation.
--
-- The admin composers auto-save their drafts and retry a send that failed
-- ambiguously (a dropped connection, a double submit). Without a key on the
-- request, the retry posted a second copy of the same message. The composer
-- now mints one key per unsent draft and keeps it until the send resolves, so
-- `POST /api/threads/:id/messages` can return the message the first attempt
-- created instead of creating another.
--
-- Uniqueness is per thread. PostgreSQL treats NULLs as distinct in a unique
-- index, so every message posted without a key — agent replies, tool posts,
-- every existing row — is unaffected and no backfill is needed.
--
-- PRODUCTION: `messages` is a large table and Prisma runs a migration inside a
-- transaction, where CONCURRENTLY is not permitted. On a deployment where the
-- lock matters, build the index CONCURRENTLY out of band first and the
-- statement below becomes a no-op.

-- AlterTable
ALTER TABLE "messages" ADD COLUMN "client_message_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "messages_thread_id_client_message_id_key"
  ON "messages" ("thread_id", "client_message_id");
