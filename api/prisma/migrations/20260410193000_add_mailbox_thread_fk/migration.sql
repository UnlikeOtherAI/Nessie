UPDATE "agent_mailbox_messages" AS amm
SET "thread_id" = NULL
WHERE amm."thread_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "threads" AS t
    WHERE t."id" = amm."thread_id"
  );

ALTER TABLE "agent_mailbox_messages"
ADD CONSTRAINT "agent_mailbox_messages_thread_id_fkey"
FOREIGN KEY ("thread_id") REFERENCES "threads"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
